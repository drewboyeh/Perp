// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

/// @notice Adapts a Pyth price feed contract to `IPriceOracle`.
/// @dev Pyth publishes US equity feeds (asset type "equity", e.g. "Equity.US.AAPL/USD").
///      Feeds only update while the underlying market is trading, so the exchange's
///      staleness check naturally halts trading outside market hours.
contract PythOracle is IPriceOracle {
    IPyth public immutable pyth;

    error InvalidPrice();
    error InvalidExponent();

    constructor(IPyth _pyth) {
        pyth = _pyth;
    }

    function getPrice(bytes32 feedId) external view returns (uint256 price, uint256 conf, uint256 publishTime) {
        PythStructs.Price memory p = pyth.getPriceUnsafe(feedId);
        if (p.price <= 0) revert InvalidPrice();
        price = _toWad(uint256(uint64(p.price)), p.expo);
        conf = _toWad(uint256(p.conf), p.expo);
        publishTime = p.publishTime;
    }

    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256) {
        return pyth.getUpdateFee(updateData);
    }

    function updatePrices(bytes[] calldata updateData) external payable {
        pyth.updatePriceFeeds{value: msg.value}(updateData);
    }

    function _toWad(uint256 value, int32 expo) private pure returns (uint256) {
        if (expo < -18 || expo > 18) revert InvalidExponent();
        int32 shift = 18 + expo;
        return value * 10 ** uint256(uint32(shift));
    }
}
