// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Price source used by the exchange. All prices are USD with 18 decimals.
/// @dev Pull-based oracles (e.g. Pyth) receive signed updates through `updatePrices`;
///      push-based oracles can implement it as a no-op with a zero fee.
interface IPriceOracle {
    /// @return price     Latest price, 18 decimals. Reverts if the feed has never reported.
    /// @return conf      Confidence interval, 18 decimals (0 if the source has none).
    /// @return publishTime Unix timestamp the price was published at.
    function getPrice(bytes32 feedId) external view returns (uint256 price, uint256 conf, uint256 publishTime);

    /// @return Fee in native token required to submit `updateData`.
    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256);

    /// @notice Push signed price updates on-chain. Must be called with exactly `getUpdateFee(updateData)`.
    function updatePrices(bytes[] calldata updateData) external payable;
}
