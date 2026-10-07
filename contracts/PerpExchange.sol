// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {SignedMath} from "@openzeppelin/contracts/utils/math/SignedMath.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";

/// @title PerpExchange
/// @notice Permissionless perpetual futures on equities.
///
///  - Anyone deposits collateral (a USD stablecoin) into a trading account.
///  - Anyone opens leveraged long/short positions on any listed stock, with isolated margin.
///    Trades are two-step: the trader commits an order, and after a short delay a keeper
///    (anyone) executes it at an oracle price published *after* the commit, so traders can't
///    trade against prices they already know.
///  - Anyone lists a new stock market by pointing at an oracle feed and paying a listing fee.
///  - Anyone provides liquidity to the shared vault, which is the counterparty to the
///    net open interest and earns trading fees, funding and trader losses.
///  - Anyone liquidates unhealthy positions for a reward.
///  - Optionally, a share of trading fees goes to a protocol treasury's trading account.
///
/// Positions are priced off the oracle. A skew-based premium is applied to fills so trades
/// that grow the long/short imbalance pay more, and funding flows from the heavier side.
///
/// Units: every USD amount and price is 18-decimal fixed point ("WAD"). Position sizes are
/// 18-decimal units of the underlying (1e18 = one share). Signed size: long > 0, short < 0.
contract PerpExchange is Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 internal constant WAD = 1e18;
    int256 internal constant IWAD = 1e18;
    uint256 public constant MAX_MARKETS = 200;
    uint256 internal constant VIRTUAL_SHARES = 1e6;
    uint256 internal constant VIRTUAL_ASSETS = 1;
    uint256 public constant MAX_PROTOCOL_FEE_SHARE = 0.5e18;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    struct MarketParams {
        uint256 maxLeverage; // WAD, e.g. 20e18 = 20x
        uint256 maintenanceMargin; // WAD fraction of notional, e.g. 0.025e18
        uint256 takerFee; // WAD fraction of notional, e.g. 0.001e18 = 10 bps
        uint256 maxOpenInterest; // USD per side
        uint256 skewScale; // USD of net skew that produces a 100% fill premium
        uint256 maxFundingRate; // WAD per day when OI is entirely on one side
    }

    struct Market {
        string symbol;
        bytes32 feedId;
        bool active; // inactive markets are close-only
        address creator;
        MarketParams params;
        uint256 longOpenInterest; // units
        uint256 shortOpenInterest; // units
        int256 fundingIndex; // cumulative funding paid per unit long, USD
        uint256 lastFundingTime;
        int256 netCostBasis; // sum(size * entryPrice), USD
        int256 netFundingBasis; // sum(size * lastFundingIndex), USD
        uint256 skewNotional; // |long - short| * price at last update, USD
    }

    struct Position {
        int256 size;
        uint256 margin;
        uint256 entryPrice;
        int256 lastFundingIndex;
    }

    struct RiskConfig {
        uint256 maxPriceAge; // seconds an oracle price stays usable for trading
        uint256 maxConfidenceRatio; // WAD, max oracle confidence / price
        uint256 maxUtilization; // WAD, max total net skew notional / vault balance
        uint256 minPositionMargin; // USD
        uint256 liquidationFee; // WAD fraction of notional paid to the liquidator
        uint256 minLiquidationReward; // USD, topped up from the vault if needed
        uint256 lpLockup; // seconds LP shares are locked after a deposit
        uint256 listingFee; // USD paid to the vault to list a market
    }

    struct OrderConfig {
        uint256 minDelay; // seconds after commit before an order can execute
        uint256 maxDelay; // seconds after commit when an order expires
        uint256 keeperFee; // USD paid by the trader to whoever executes or cancels the order
    }

    /// @dev A pending order. `commitTime == 0` means no order.
    struct Order {
        int256 sizeDelta;
        int256 marginDelta; // positive amounts are escrowed from the account at commit
        uint256 acceptablePrice;
        uint128 keeperFee; // escrowed at commit
        uint64 commitTime;
        bool reduceOnly; // only shrink the position, clamped to its size at execution
    }

    struct OrderView {
        uint256 marketId;
        string symbol;
        Order order;
        uint256 executableAt;
        uint256 expiresAt;
    }

    struct MarketView {
        uint256 id;
        string symbol;
        bytes32 feedId;
        bool active;
        address creator;
        MarketParams params;
        uint256 price;
        uint256 publishTime;
        bool priceFresh;
        uint256 longOpenInterest;
        uint256 shortOpenInterest;
        int256 fundingRate; // WAD per day, positive = longs pay shorts
        int256 fundingIndex;
    }

    struct PositionView {
        uint256 marketId;
        string symbol;
        int256 size;
        uint256 margin;
        uint256 entryPrice;
        uint256 markPrice;
        int256 unrealizedPnl;
        int256 accruedFunding; // positive = owed by the trader
        int256 equity;
        uint256 notional;
        uint256 leverage; // WAD
        uint256 liquidationPrice;
        bool liquidatable;
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    IERC20 public immutable collateral;
    uint256 public immutable collateralScale; // 10 ** (18 - decimals)

    IPriceOracle public oracle;
    RiskConfig public risk;
    MarketParams public defaultMarketParams;
    OrderConfig public orderConfig;

    Market[] internal _markets;
    mapping(bytes32 => bool) public feedListed;
    mapping(uint256 => mapping(address => Position)) public positions;
    mapping(address => uint256) public balances;
    mapping(uint256 => mapping(address => Order)) public orders;

    uint256 public vaultBalance;
    /// @notice Receives `protocolFeeShare` of every trading fee, credited to its trading account.
    address public treasury;
    uint256 public protocolFeeShare; // WAD fraction of trading fees, the rest goes to the vault
    uint256 public totalSkewNotional;
    uint256 public totalLpShares;
    mapping(address => uint256) public lpShares;
    mapping(address => uint256) public lpUnlockTime;

    // ---------------------------------------------------------------------
    // Events & errors
    // ---------------------------------------------------------------------

    event Deposited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event MarketCreated(uint256 indexed marketId, string symbol, bytes32 feedId, address indexed creator);
    event MarketParamsUpdated(uint256 indexed marketId, MarketParams params);
    event MarketActiveSet(uint256 indexed marketId, bool active);
    event PositionModified(
        uint256 indexed marketId,
        address indexed trader,
        int256 sizeDelta,
        int256 newSize,
        uint256 fillPrice,
        uint256 fee,
        int256 realizedPnl,
        int256 fundingPaid,
        uint256 newMargin
    );
    event OrderCommitted(
        uint256 indexed marketId,
        address indexed trader,
        int256 sizeDelta,
        int256 marginDelta,
        uint256 acceptablePrice,
        bool reduceOnly,
        uint256 keeperFee
    );
    event OrderExecuted(uint256 indexed marketId, address indexed trader, address indexed keeper);
    /// @param reason ABI-encoded revert data when execution failed; empty for expired orders.
    event OrderCancelled(uint256 indexed marketId, address indexed trader, address indexed caller, bytes reason);
    event Liquidated(
        uint256 indexed marketId,
        address indexed trader,
        address indexed liquidator,
        int256 size,
        uint256 price,
        uint256 reward,
        uint256 badDebt
    );
    event LiquidityAdded(address indexed provider, uint256 amount, uint256 shares);
    event LiquidityRemoved(address indexed provider, uint256 amount, uint256 shares);
    event ProfitHaircut(address indexed trader, uint256 owed, uint256 paid);
    event RiskConfigUpdated(RiskConfig config);
    event DefaultMarketParamsUpdated(MarketParams params);
    event OracleUpdated(address oracle);
    event OrderConfigUpdated(OrderConfig config);
    event ProtocolFeeUpdated(address treasury, uint256 share);

    error ZeroAmount();
    error InsufficientBalance();
    error UnknownMarket();
    error MarketNotActive();
    error FeedAlreadyListed();
    error InvalidSymbol();
    error TooManyMarkets();
    error StalePrice(bytes32 feedId, uint256 publishTime);
    error PriceUncertain(bytes32 feedId);
    error InvalidPrice();
    error InsufficientOracleFee();
    error RefundFailed();
    error NothingToDo();
    error SlippageExceeded(uint256 fillPrice, uint256 acceptablePrice);
    error InsufficientMargin();
    error MarginBelowMinimum();
    error PositionUnderwater();
    error OpenInterestCapExceeded();
    error InsufficientLiquidity();
    error NoPosition();
    error NotLiquidatable();
    error SharesLocked(uint256 unlockTime);
    error VaultInsolvent();
    error MinOutput();
    error InvalidParams();
    error OrderPending();
    error NoOrder();
    error OrderNotReady(uint256 executableAt);
    error OrderExpired();
    error OrderNotExpired(uint256 expiresAt);
    error PriceNotAfterCommit(uint256 publishTime, uint256 requiredTime);
    error NothingToReduce();
    error OnlySelf();
    error ExecutionOutOfGas();

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    constructor(
        IERC20Metadata _collateral,
        IPriceOracle _oracle,
        RiskConfig memory _risk,
        MarketParams memory _defaultParams,
        OrderConfig memory _orderConfig
    ) Ownable(msg.sender) {
        uint8 decimals = _collateral.decimals();
        if (decimals > 18) revert InvalidParams();
        collateral = IERC20(address(_collateral));
        collateralScale = 10 ** (18 - decimals);
        oracle = _oracle;
        _setRiskConfig(_risk);
        _validateParams(_defaultParams);
        defaultMarketParams = _defaultParams;
        _setOrderConfig(_orderConfig);
    }

    // ---------------------------------------------------------------------
    // Accounts
    // ---------------------------------------------------------------------

    /// @notice Deposit collateral tokens into your trading account.
    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        balances[msg.sender] += amount * collateralScale;
        emit Deposited(msg.sender, amount);
    }

    /// @notice Withdraw collateral tokens from your trading account. Always allowed, even when paused.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _debit(msg.sender, amount * collateralScale);
        collateral.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Market listing
    // ---------------------------------------------------------------------

    /// @notice List a new stock market. Anyone can call this. The feed must have a fresh,
    ///         confident price, and the listing fee is paid from the caller's account to the vault.
    function createMarket(string calldata symbol, bytes32 feedId, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 marketId)
    {
        uint256 len = bytes(symbol).length;
        if (len == 0 || len > 16) revert InvalidSymbol();
        if (feedId == bytes32(0) || feedListed[feedId]) revert FeedAlreadyListed();
        if (_markets.length >= MAX_MARKETS) revert TooManyMarkets();

        _updateOracle(priceUpdate);
        _freshPrice(feedId);

        uint256 fee = risk.listingFee;
        if (fee > 0) {
            _debit(msg.sender, fee);
            vaultBalance += fee;
        }

        marketId = _markets.length;
        Market storage m = _markets.push();
        m.symbol = symbol;
        m.feedId = feedId;
        m.active = true;
        m.creator = msg.sender;
        m.params = defaultMarketParams;
        m.lastFundingTime = block.timestamp;
        feedListed[feedId] = true;

        emit MarketCreated(marketId, symbol, feedId, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Trading
    // ---------------------------------------------------------------------

    /// @notice Step 1 of a trade: commit an order to open, increase, reduce, flip or close a
    ///         position and/or withdraw margin. It executes after `orderConfig.minDelay` at a price
    ///         published after the commit. Positive `marginDelta` and the keeper fee are escrowed
    ///         from your account now and refunded if the order is cancelled.
    /// @param sizeDelta Units to buy (> 0) or sell (< 0).
    /// @param marginDelta Collateral to move from your account into the position (> 0) or back (< 0).
    /// @param acceptablePrice Worst fill price: max for buys, min for sells. Worse fills cancel the order.
    /// @param reduceOnly Only shrink the existing position (clamped to its size at execution).
    function commitOrder(
        uint256 marketId,
        int256 sizeDelta,
        int256 marginDelta,
        uint256 acceptablePrice,
        bool reduceOnly
    ) external nonReentrant {
        Market storage m = _market(marketId);
        if (sizeDelta == 0 && marginDelta == 0) revert NothingToDo();
        if (orders[marketId][msg.sender].commitTime != 0) revert OrderPending();
        if (reduceOnly) {
            if (sizeDelta == 0 || marginDelta != 0) revert InvalidParams();
        } else if (paused() || !m.active) {
            // Fail fast on orders that add risk, which would only be rejected at execution.
            int256 size = positions[marketId][msg.sender].size;
            bool reducing = marginDelta >= 0
                && (sizeDelta == 0
                    || (size != 0 && (sizeDelta > 0) != (size > 0) && SignedMath.abs(sizeDelta) <= SignedMath.abs(size)));
            if (!reducing) {
                _requireNotPaused();
                revert MarketNotActive();
            }
        }

        uint256 keeperFee = orderConfig.keeperFee;
        _debit(msg.sender, keeperFee + (marginDelta > 0 ? uint256(marginDelta) : 0));
        orders[marketId][msg.sender] = Order({
            sizeDelta: sizeDelta,
            marginDelta: marginDelta,
            acceptablePrice: acceptablePrice,
            keeperFee: keeperFee.toUint128(),
            commitTime: block.timestamp.toUint64(),
            reduceOnly: reduceOnly
        });
        emit OrderCommitted(marketId, msg.sender, sizeDelta, marginDelta, acceptablePrice, reduceOnly, keeperFee);
    }

    /// @notice Step 2 of a trade: execute a pending order. Anyone can call this and earns the
    ///         order's keeper fee. Requires an oracle price published at least `minDelay` after
    ///         the commit. If the order itself is invalid at that price (slippage, margin, caps,
    ///         market closed for new risk) it is cancelled and its escrow refunded, minus the fee.
    function executeOrder(uint256 marketId, address trader, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
    {
        _updateOracle(priceUpdate);
        Order memory o = orders[marketId][trader];
        if (o.commitTime == 0) revert NoOrder();
        OrderConfig memory cfg = orderConfig;
        if (block.timestamp < o.commitTime + cfg.minDelay) revert OrderNotReady(o.commitTime + cfg.minDelay);
        if (block.timestamp > o.commitTime + cfg.maxDelay) revert OrderExpired();

        // Oracle problems are the keeper's to fix (revert), not a reason to cancel the order.
        (, uint256 publishTime) = _freshPriceAndTime(_market(marketId).feedId);
        if (publishTime < o.commitTime + cfg.minDelay) {
            revert PriceNotAfterCommit(publishTime, o.commitTime + cfg.minDelay);
        }

        delete orders[marketId][trader];
        if (o.marginDelta > 0) balances[trader] += uint256(o.marginDelta); // re-debited on success
        try this.selfExecuteOrder(marketId, trader, o) {
            emit OrderExecuted(marketId, trader, msg.sender);
        } catch (bytes memory reason) {
            // Out-of-gas reverts carry no data; don't let a keeper starve the call to force a cancel.
            if (reason.length == 0) revert ExecutionOutOfGas();
            emit OrderCancelled(marketId, trader, msg.sender, reason);
        }
        balances[msg.sender] += o.keeperFee;
    }

    /// @dev Runs an order's state changes so `executeOrder` can catch failures atomically.
    function selfExecuteOrder(uint256 marketId, address trader, Order calldata o) external {
        if (msg.sender != address(this)) revert OnlySelf();
        int256 sizeDelta = o.sizeDelta;
        if (o.reduceOnly) {
            int256 size = positions[marketId][trader].size;
            if (size == 0 || (sizeDelta > 0) == (size > 0)) revert NothingToReduce();
            if (SignedMath.abs(sizeDelta) > SignedMath.abs(size)) sizeDelta = -size;
        }
        _modifyPosition(trader, marketId, sizeDelta, o.marginDelta, o.acceptablePrice);
    }

    /// @notice Cancel an order that expired without being executed. Anyone can call this; the
    ///         keeper fee goes to the caller (or back to the trader if they cancel themselves).
    ///         Unexpired orders can't be cancelled, so a commit is never a free option.
    function cancelOrder(uint256 marketId, address trader) external nonReentrant {
        Order memory o = orders[marketId][trader];
        if (o.commitTime == 0) revert NoOrder();
        uint256 expiresAt = o.commitTime + orderConfig.maxDelay;
        if (block.timestamp <= expiresAt) revert OrderNotExpired(expiresAt);
        delete orders[marketId][trader];
        if (o.marginDelta > 0) balances[trader] += uint256(o.marginDelta);
        balances[msg.sender] += o.keeperFee;
        emit OrderCancelled(marketId, trader, msg.sender, "");
    }

    /// @notice Add margin to an open position immediately (e.g. to avoid liquidation). Adding
    ///         margin only lowers risk, so it doesn't need the delayed-order flow.
    function addMargin(uint256 marketId, uint256 amount, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
    {
        _updateOracle(priceUpdate);
        if (amount == 0) revert ZeroAmount();
        if (positions[marketId][msg.sender].size == 0) revert NoPosition();
        _modifyPosition(msg.sender, marketId, 0, amount.toInt256(), 0);
    }

    /// @notice Liquidate a position whose equity is below maintenance margin. Anyone can call.
    function liquidate(uint256 marketId, address trader, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
        returns (uint256 reward)
    {
        _updateOracle(priceUpdate);
        Market storage m = _market(marketId);
        uint256 price = _freshPrice(m.feedId);
        _accrueFunding(m, price);

        Position memory pos = positions[marketId][trader];
        if (pos.size == 0) revert NoPosition();

        int256 funding = _accruedFunding(pos, m.fundingIndex);
        int256 pnl = _pnl(pos, price);
        uint256 notional = _notional(pos.size, price);
        int256 equity = pos.margin.toInt256() + pnl - funding;
        if (equity >= (notional * m.params.maintenanceMargin / WAD).toInt256()) revert NotLiquidatable();

        _removeFromAggregates(m, pos);
        _updateOpenInterest(m, pos.size, 0);
        delete positions[marketId][trader];

        // Settle the trader's PnL and funding against the vault, bounded by their margin.
        uint256 payout;
        uint256 badDebt;
        int256 traderGain = pnl - funding;
        if (traderGain >= 0) {
            payout = pos.margin + _payFromVault(trader, uint256(traderGain));
        } else {
            uint256 loss = uint256(-traderGain);
            if (loss >= pos.margin) {
                vaultBalance += pos.margin;
                badDebt = loss - pos.margin;
            } else {
                vaultBalance += loss;
                payout = pos.margin - loss;
            }
        }

        reward = Math.min(notional * risk.liquidationFee / WAD, payout);
        payout -= reward;
        if (reward < risk.minLiquidationReward) {
            uint256 topUp = Math.min(risk.minLiquidationReward - reward, vaultBalance);
            vaultBalance -= topUp;
            reward += topUp;
        }
        balances[msg.sender] += reward;
        balances[trader] += payout;

        _updateSkew(m, price, false);
        emit Liquidated(marketId, trader, msg.sender, pos.size, price, reward, badDebt);
    }

    // ---------------------------------------------------------------------
    // Liquidity provision
    // ---------------------------------------------------------------------

    /// @notice Deposit collateral into the vault that backs all markets, receiving LP shares.
    function addLiquidity(uint256 amount, uint256 minShares, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        if (amount == 0) revert ZeroAmount();
        _updateOracle(priceUpdate);
        int256 nav = _vaultNav(true);
        if (nav <= 0 && totalLpShares > 0) revert VaultInsolvent();

        uint256 amountWad = amount * collateralScale;
        uint256 navU = nav > 0 ? uint256(nav) : 0;
        shares = Math.mulDiv(amountWad, totalLpShares + VIRTUAL_SHARES, navU + VIRTUAL_ASSETS);
        if (shares == 0 || shares < minShares) revert MinOutput();

        collateral.safeTransferFrom(msg.sender, address(this), amount);
        vaultBalance += amountWad;
        totalLpShares += shares;
        lpShares[msg.sender] += shares;
        lpUnlockTime[msg.sender] = block.timestamp + risk.lpLockup;
        emit LiquidityAdded(msg.sender, amount, shares);
    }

    /// @notice Burn LP shares for their share of vault NAV, paid in collateral tokens.
    function removeLiquidity(uint256 shares, uint256 minAmount, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
        returns (uint256 amount)
    {
        if (shares == 0) revert ZeroAmount();
        if (lpShares[msg.sender] < shares) revert InsufficientBalance();
        if (block.timestamp < lpUnlockTime[msg.sender]) revert SharesLocked(lpUnlockTime[msg.sender]);
        _updateOracle(priceUpdate);
        int256 nav = _vaultNav(true);
        if (nav <= 0) revert VaultInsolvent();

        uint256 amountWad = Math.mulDiv(shares, uint256(nav) + VIRTUAL_ASSETS, totalLpShares + VIRTUAL_SHARES);
        amount = amountWad / collateralScale;
        amountWad = amount * collateralScale;
        if (amount == 0 || amount < minAmount) revert MinOutput();
        if (amountWad > vaultBalance) revert InsufficientLiquidity();

        vaultBalance -= amountWad;
        if (totalSkewNotional * WAD > vaultBalance * risk.maxUtilization) revert InsufficientLiquidity();
        totalLpShares -= shares;
        lpShares[msg.sender] -= shares;
        collateral.safeTransfer(msg.sender, amount);
        emit LiquidityRemoved(msg.sender, amount, shares);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function marketCount() external view returns (uint256) {
        return _markets.length;
    }

    function getMarket(uint256 marketId) external view returns (Market memory) {
        return _market(marketId);
    }

    function getMarketView(uint256 marketId) public view returns (MarketView memory v) {
        Market storage m = _market(marketId);
        v.id = marketId;
        v.symbol = m.symbol;
        v.feedId = m.feedId;
        v.active = m.active;
        v.creator = m.creator;
        v.params = m.params;
        v.longOpenInterest = m.longOpenInterest;
        v.shortOpenInterest = m.shortOpenInterest;
        v.fundingRate = _fundingRate(m);
        (v.price, v.publishTime, v.priceFresh) = _tryPrice(m.feedId);
        v.fundingIndex = _currentFundingIndex(m, v.price);
    }

    function getMarkets() external view returns (MarketView[] memory views) {
        views = new MarketView[](_markets.length);
        for (uint256 i; i < views.length; ++i) views[i] = getMarketView(i);
    }

    /// @notice Detailed, mark-to-market view of a position (uses the latest oracle price, fresh or not).
    function getPosition(uint256 marketId, address trader) public view returns (PositionView memory v) {
        Market storage m = _market(marketId);
        Position memory pos = positions[marketId][trader];
        v.marketId = marketId;
        v.symbol = m.symbol;
        if (pos.size == 0) return v;
        (uint256 price,,) = _tryPrice(m.feedId);
        v.size = pos.size;
        v.margin = pos.margin;
        v.entryPrice = pos.entryPrice;
        v.markPrice = price;
        v.unrealizedPnl = _pnl(pos, price);
        v.accruedFunding = _accruedFunding(pos, _currentFundingIndex(m, price));
        v.equity = pos.margin.toInt256() + v.unrealizedPnl - v.accruedFunding;
        v.notional = _notional(pos.size, price);
        v.leverage = v.equity > 0 ? v.notional * WAD / uint256(v.equity) : type(uint256).max;
        v.liquidatable = v.equity < (v.notional * m.params.maintenanceMargin / WAD).toInt256();
        v.liquidationPrice = _liquidationPrice(pos, v.accruedFunding, m.params.maintenanceMargin);
    }

    /// @notice All open positions of `trader` across markets.
    function getPositions(address trader) external view returns (PositionView[] memory out) {
        uint256 n;
        PositionView[] memory tmp = new PositionView[](_markets.length);
        for (uint256 i; i < _markets.length; ++i) {
            if (positions[i][trader].size != 0) tmp[n++] = getPosition(i, trader);
        }
        out = new PositionView[](n);
        for (uint256 i; i < n; ++i) out[i] = tmp[i];
    }

    /// @notice All pending orders of `trader` across markets.
    function getOrders(address trader) external view returns (OrderView[] memory out) {
        uint256 n;
        OrderView[] memory tmp = new OrderView[](_markets.length);
        for (uint256 i; i < _markets.length; ++i) {
            Order memory o = orders[i][trader];
            if (o.commitTime == 0) continue;
            tmp[n++] = OrderView(
                i, _markets[i].symbol, o, o.commitTime + orderConfig.minDelay, o.commitTime + orderConfig.maxDelay
            );
        }
        out = new OrderView[](n);
        for (uint256 i; i < n; ++i) out[i] = tmp[i];
    }

    /// @notice Quote the fill price for a trade at the current oracle price.
    function quoteFillPrice(uint256 marketId, int256 sizeDelta) external view returns (uint256) {
        Market storage m = _market(marketId);
        (uint256 price,,) = _tryPrice(m.feedId);
        return _fillPrice(m, price, sizeDelta);
    }

    /// @notice Vault net asset value: balance minus traders' aggregate unrealized PnL and funding.
    function vaultNav() external view returns (int256) {
        return _vaultNav(false);
    }

    /// @notice USD value of one LP share (WAD).
    function lpSharePrice() external view returns (uint256) {
        int256 nav = _vaultNav(false);
        if (nav <= 0) return 0;
        return Math.mulDiv(WAD, uint256(nav) + VIRTUAL_ASSETS, totalLpShares + VIRTUAL_SHARES);
    }

    function getOracleUpdateFee(bytes[] calldata priceUpdate) external view returns (uint256) {
        return priceUpdate.length == 0 ? 0 : oracle.getUpdateFee(priceUpdate);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setMarketParams(uint256 marketId, MarketParams calldata params) external onlyOwner {
        _validateParams(params);
        Market storage m = _market(marketId);
        (uint256 price,,) = _tryPrice(m.feedId);
        _accrueFunding(m, price);
        m.params = params;
        emit MarketParamsUpdated(marketId, params);
    }

    /// @notice Inactive markets are close-only: positions can be reduced, closed or liquidated.
    function setMarketActive(uint256 marketId, bool active) external onlyOwner {
        _market(marketId).active = active;
        emit MarketActiveSet(marketId, active);
    }

    function setDefaultMarketParams(MarketParams calldata params) external onlyOwner {
        _validateParams(params);
        defaultMarketParams = params;
        emit DefaultMarketParamsUpdated(params);
    }

    function setRiskConfig(RiskConfig calldata config) external onlyOwner {
        _setRiskConfig(config);
    }

    function setOrderConfig(OrderConfig calldata config) external onlyOwner {
        _setOrderConfig(config);
    }

    /// @notice Sends `share` (WAD, at most 50%) of every trading fee to `treasury`'s trading account,
    ///         which withdraws it like any other balance. A zero share sends all fees to the vault.
    function setProtocolFee(address newTreasury, uint256 share) external onlyOwner {
        if (share > MAX_PROTOCOL_FEE_SHARE || (share > 0 && newTreasury == address(0))) revert InvalidParams();
        treasury = newTreasury;
        protocolFeeShare = share;
        emit ProtocolFeeUpdated(newTreasury, share);
    }

    function setOracle(IPriceOracle newOracle) external onlyOwner {
        oracle = newOracle;
        emit OracleUpdated(address(newOracle));
    }

    /// @notice Pausing blocks new risk (deposits, opening/increasing, listing, LP deposits).
    ///         Withdrawals, closing, reducing, order execution and liquidations keep working.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Internal: trading
    // ---------------------------------------------------------------------

    function _modifyPosition(
        address trader,
        uint256 marketId,
        int256 sizeDelta,
        int256 marginDelta,
        uint256 acceptablePrice
    ) internal {
        if (sizeDelta == 0 && marginDelta == 0) revert NothingToDo();
        Market storage m = _market(marketId);
        Position memory pos = positions[marketId][trader];

        bool sizeIncrease = sizeDelta != 0
            && (pos.size == 0 || (sizeDelta > 0) == (pos.size > 0) || SignedMath.abs(sizeDelta) > SignedMath.abs(pos.size));
        bool riskIncreasing = sizeIncrease || marginDelta < 0;
        if (riskIncreasing) {
            _requireNotPaused();
            if (!m.active) revert MarketNotActive();
        }

        uint256 price = _freshPrice(m.feedId);
        _accrueFunding(m, price);
        _removeFromAggregates(m, pos);

        int256 margin = pos.margin.toInt256();
        int256 funding;
        if (pos.size != 0) {
            funding = _accruedFunding(pos, m.fundingIndex);
            margin += _settleWithVault(trader, -funding);
        }
        if (marginDelta > 0) {
            _debit(trader, uint256(marginDelta));
            margin += marginDelta;
        }

        int256 newSize = pos.size + sizeDelta;
        uint256 entry = pos.entryPrice;
        uint256 fillPrice;
        uint256 fee;
        int256 realizedPnl;
        if (sizeDelta != 0) {
            fillPrice = _fillPrice(m, price, sizeDelta);
            if (sizeDelta > 0 ? fillPrice > acceptablePrice : fillPrice < acceptablePrice) {
                revert SlippageExceeded(fillPrice, acceptablePrice);
            }

            // Realize PnL on the part of the existing position being closed.
            if (pos.size != 0 && (sizeDelta > 0) != (pos.size > 0)) {
                int256 closed = SignedMath.abs(sizeDelta) >= SignedMath.abs(pos.size) ? pos.size : -sizeDelta;
                realizedPnl = _settleWithVault(trader, closed * (fillPrice.toInt256() - entry.toInt256()) / IWAD);
                margin += realizedPnl;
            }

            if (newSize == 0) {
                entry = 0;
            } else if (pos.size == 0 || (newSize > 0) != (pos.size > 0)) {
                entry = fillPrice; // fresh position or flipped side
            } else if (SignedMath.abs(newSize) > SignedMath.abs(pos.size)) {
                entry = (SignedMath.abs(pos.size) * entry + SignedMath.abs(sizeDelta) * fillPrice)
                    / SignedMath.abs(newSize);
            }

            fee = _notional(sizeDelta, fillPrice) * m.params.takerFee / WAD;
            margin -= fee.toInt256();
            uint256 protocolFee = fee * protocolFeeShare / WAD;
            if (protocolFee > 0) balances[treasury] += protocolFee;
            vaultBalance += fee - protocolFee;

            _updateOpenInterest(m, pos.size, newSize);
        }

        if (marginDelta < 0) {
            margin += marginDelta;
            balances[trader] += uint256(-marginDelta);
        }
        if (margin < 0) {
            // Losses exceed margin: the position can only be liquidated, not closed or reduced.
            if (newSize == 0 || !riskIncreasing) revert PositionUnderwater();
            revert InsufficientMargin();
        }

        uint256 newMargin;
        if (newSize == 0) {
            balances[trader] += uint256(margin);
            delete positions[marketId][trader];
        } else {
            Position memory next = Position(newSize, uint256(margin), entry, m.fundingIndex);
            if (riskIncreasing) {
                if (next.margin < risk.minPositionMargin) revert MarginBelowMinimum();
                int256 equity = margin + _pnl(next, price);
                uint256 initialMargin = _notional(newSize, price) * WAD / m.params.maxLeverage;
                if (equity < initialMargin.toInt256()) revert InsufficientMargin();
            }
            positions[marketId][trader] = next;
            _addToAggregates(m, next);
            newMargin = next.margin;
        }

        _updateSkew(m, price, sizeIncrease);
        if (sizeIncrease) _checkOpenInterestCaps(m, price, pos.size, newSize);

        emit PositionModified(marketId, trader, sizeDelta, newSize, fillPrice, fee, realizedPnl, funding, newMargin);
    }

    /// @dev Moves `traderGain` from the vault to the trader (or the reverse if negative).
    ///      If the vault cannot cover a gain, the payout is haircut to what it holds.
    function _settleWithVault(address trader, int256 traderGain) internal returns (int256) {
        if (traderGain <= 0) {
            vaultBalance += uint256(-traderGain);
            return traderGain;
        }
        return _payFromVault(trader, uint256(traderGain)).toInt256();
    }

    function _payFromVault(address trader, uint256 owed) internal returns (uint256 paid) {
        paid = Math.min(owed, vaultBalance);
        vaultBalance -= paid;
        if (paid < owed) emit ProfitHaircut(trader, owed, paid);
    }

    function _fillPrice(Market storage m, uint256 price, int256 sizeDelta) internal view returns (uint256) {
        // Premium is proportional to the average skew across the trade (Synthetix-style):
        // trades that grow the imbalance fill worse, trades that shrink it fill better.
        int256 skew = m.longOpenInterest.toInt256() - m.shortOpenInterest.toInt256();
        int256 avgSkew = skew + sizeDelta / 2;
        int256 premium = avgSkew * price.toInt256() / m.params.skewScale.toInt256();
        int256 maxPremium = IWAD / 10;
        if (premium > maxPremium) premium = maxPremium;
        if (premium < -maxPremium) premium = -maxPremium;
        return uint256(price.toInt256() * (IWAD + premium) / IWAD);
    }

    function _fundingRate(Market storage m) internal view returns (int256) {
        uint256 total = m.longOpenInterest + m.shortOpenInterest;
        if (total == 0) return 0;
        int256 skew = m.longOpenInterest.toInt256() - m.shortOpenInterest.toInt256();
        return skew * m.params.maxFundingRate.toInt256() / total.toInt256();
    }

    function _currentFundingIndex(Market storage m, uint256 price) internal view returns (int256) {
        uint256 elapsed = block.timestamp - m.lastFundingTime;
        return m.fundingIndex + _fundingRate(m) * elapsed.toInt256() * price.toInt256() / (1 days * IWAD);
    }

    function _accrueFunding(Market storage m, uint256 price) internal {
        m.fundingIndex = _currentFundingIndex(m, price);
        m.lastFundingTime = block.timestamp;
    }

    function _updateOpenInterest(Market storage m, int256 oldSize, int256 newSize) internal {
        if (oldSize > 0) m.longOpenInterest -= uint256(oldSize);
        else m.shortOpenInterest -= uint256(-oldSize);
        if (newSize > 0) m.longOpenInterest += uint256(newSize);
        else m.shortOpenInterest += uint256(-newSize);
    }

    function _checkOpenInterestCaps(Market storage m, uint256 price, int256 oldSize, int256 newSize) internal view {
        bool longGrew = newSize > 0 && newSize > (oldSize > 0 ? oldSize : int256(0));
        bool shortGrew = newSize < 0 && newSize < (oldSize < 0 ? oldSize : int256(0));
        uint256 cap = m.params.maxOpenInterest;
        if (longGrew && m.longOpenInterest * price / WAD > cap) revert OpenInterestCapExceeded();
        if (shortGrew && m.shortOpenInterest * price / WAD > cap) revert OpenInterestCapExceeded();
    }

    /// @dev Tracks each market's net skew notional (the vault's exposure) and enforces that the
    ///      total stays within the vault's utilization limit whenever exposure grows.
    function _updateSkew(Market storage m, uint256 price, bool exposureMayGrow) internal {
        uint256 skewUnits = m.longOpenInterest > m.shortOpenInterest
            ? m.longOpenInterest - m.shortOpenInterest
            : m.shortOpenInterest - m.longOpenInterest;
        uint256 newSkew = skewUnits * price / WAD;
        uint256 oldSkew = m.skewNotional;
        totalSkewNotional = totalSkewNotional - oldSkew + newSkew;
        m.skewNotional = newSkew;
        if (exposureMayGrow && newSkew > oldSkew && totalSkewNotional * WAD > vaultBalance * risk.maxUtilization) {
            revert InsufficientLiquidity();
        }
    }

    function _addToAggregates(Market storage m, Position memory pos) internal {
        if (pos.size == 0) return;
        m.netCostBasis += pos.size * pos.entryPrice.toInt256() / IWAD;
        m.netFundingBasis += pos.size * pos.lastFundingIndex / IWAD;
    }

    function _removeFromAggregates(Market storage m, Position memory pos) internal {
        if (pos.size == 0) return;
        m.netCostBasis -= pos.size * pos.entryPrice.toInt256() / IWAD;
        m.netFundingBasis -= pos.size * pos.lastFundingIndex / IWAD;
    }

    // ---------------------------------------------------------------------
    // Internal: valuation
    // ---------------------------------------------------------------------

    function _pnl(Position memory pos, uint256 price) internal pure returns (int256) {
        return pos.size * (price.toInt256() - pos.entryPrice.toInt256()) / IWAD;
    }

    function _accruedFunding(Position memory pos, int256 fundingIndex) internal pure returns (int256) {
        return pos.size * (fundingIndex - pos.lastFundingIndex) / IWAD;
    }

    function _notional(int256 size, uint256 price) internal pure returns (uint256) {
        return SignedMath.abs(size) * price / WAD;
    }

    function _liquidationPrice(Position memory pos, int256 funding, uint256 mm) internal pure returns (uint256) {
        // Solve margin + size * (P - entry) - funding = mm * |size| * P for P.
        int256 size = pos.size;
        int256 m = pos.margin.toInt256() - funding;
        int256 mmI = mm.toInt256();
        int256 num;
        int256 den;
        if (size > 0) {
            num = size * pos.entryPrice.toInt256() / IWAD - m;
            den = size * (IWAD - mmI) / IWAD;
        } else {
            num = m - size * pos.entryPrice.toInt256() / IWAD;
            den = -size * (IWAD + mmI) / IWAD;
        }
        if (num <= 0 || den <= 0) return 0;
        return uint256(num) * WAD / uint256(den);
    }

    /// @dev Vault NAV = balance - sum over markets of traders' unrealized PnL net of accrued funding.
    ///      With `requireFresh`, every market that has open interest must have a fresh price.
    function _vaultNav(bool requireFresh) internal view returns (int256 nav) {
        nav = vaultBalance.toInt256();
        for (uint256 i; i < _markets.length; ++i) {
            Market storage m = _markets[i];
            int256 net = m.longOpenInterest.toInt256() - m.shortOpenInterest.toInt256();
            if (net == 0 && m.netCostBasis == 0 && m.netFundingBasis == 0) continue;
            uint256 price;
            if (requireFresh) {
                price = _freshPrice(m.feedId);
            } else {
                (price,,) = _tryPrice(m.feedId);
            }
            int256 idx = _currentFundingIndex(m, price);
            int256 traderPnl = net * price.toInt256() / IWAD - m.netCostBasis;
            int256 traderFunding = net * idx / IWAD - m.netFundingBasis;
            nav -= traderPnl - traderFunding;
        }
    }

    // ---------------------------------------------------------------------
    // Internal: oracle & helpers
    // ---------------------------------------------------------------------

    function _updateOracle(bytes[] calldata priceUpdate) internal {
        uint256 fee;
        if (priceUpdate.length > 0) {
            fee = oracle.getUpdateFee(priceUpdate);
            if (msg.value < fee) revert InsufficientOracleFee();
            oracle.updatePrices{value: fee}(priceUpdate);
        }
        if (msg.value > fee) {
            (bool ok,) = msg.sender.call{value: msg.value - fee}("");
            if (!ok) revert RefundFailed();
        }
    }

    function _freshPrice(bytes32 feedId) internal view returns (uint256 price) {
        (price,) = _freshPriceAndTime(feedId);
    }

    function _freshPriceAndTime(bytes32 feedId) internal view returns (uint256 price, uint256 publishTime) {
        uint256 conf;
        (price, conf, publishTime) = oracle.getPrice(feedId);
        if (price == 0) revert InvalidPrice();
        if (publishTime + risk.maxPriceAge < block.timestamp) revert StalePrice(feedId, publishTime);
        if (conf * WAD > price * risk.maxConfidenceRatio) revert PriceUncertain(feedId);
    }

    function _tryPrice(bytes32 feedId) internal view returns (uint256 price, uint256 publishTime, bool fresh) {
        try oracle.getPrice(feedId) returns (uint256 p, uint256, uint256 t) {
            price = p;
            publishTime = t;
            fresh = p > 0 && t + risk.maxPriceAge >= block.timestamp;
        } catch {}
    }

    function _market(uint256 marketId) internal view returns (Market storage) {
        if (marketId >= _markets.length) revert UnknownMarket();
        return _markets[marketId];
    }

    function _debit(address account, uint256 amount) internal {
        uint256 bal = balances[account];
        if (bal < amount) revert InsufficientBalance();
        balances[account] = bal - amount;
    }

    function _validateParams(MarketParams memory p) internal pure {
        if (
            p.maxLeverage < WAD || p.maxLeverage > 100 * WAD || p.maintenanceMargin == 0
                || p.maintenanceMargin * p.maxLeverage >= WAD * WAD || p.takerFee > WAD / 100 || p.skewScale == 0
                || p.maxFundingRate > WAD / 10
        ) revert InvalidParams();
    }

    function _setOrderConfig(OrderConfig memory c) internal {
        if (c.maxDelay <= c.minDelay || c.maxDelay > 1 hours || c.keeperFee > 50 * WAD) revert InvalidParams();
        orderConfig = c;
        emit OrderConfigUpdated(c);
    }

    function _setRiskConfig(RiskConfig memory c) internal {
        if (
            c.maxPriceAge == 0 || c.maxPriceAge > 1 days || c.maxConfidenceRatio > WAD / 10 || c.maxUtilization == 0
                || c.liquidationFee > WAD / 20 || c.lpLockup > 30 days
        ) revert InvalidParams();
        risk = c;
        emit RiskConfigUpdated(c);
    }
}
