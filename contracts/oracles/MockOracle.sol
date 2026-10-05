// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

/// @notice Push oracle for local development and testnets. Authorised reporters set prices
///         directly. NOT for production: prices are fully trusted to the reporters.
contract MockOracle is IPriceOracle, Ownable {
    struct Report {
        uint256 price;
        uint256 publishTime;
    }

    mapping(bytes32 => Report) public reports;
    mapping(address => bool) public isReporter;
    /// @notice When true, anyone may seed the first price of a feed that has never reported,
    ///         so new stocks can be listed on dev/test deployments. Reporters drive it after that.
    bool public permissionlessInit;

    event ReporterSet(address indexed reporter, bool allowed);
    event PermissionlessInitSet(bool enabled);
    event PriceSet(bytes32 indexed feedId, uint256 price, uint256 publishTime);

    error NotReporter();
    error NoPrice();
    error LengthMismatch();
    error AlreadyInitialized();

    constructor() Ownable(msg.sender) {
        isReporter[msg.sender] = true;
    }

    function setReporter(address reporter, bool allowed) external onlyOwner {
        isReporter[reporter] = allowed;
        emit ReporterSet(reporter, allowed);
    }

    function setPermissionlessInit(bool enabled) external onlyOwner {
        permissionlessInit = enabled;
        emit PermissionlessInitSet(enabled);
    }

    function setPrice(bytes32 feedId, uint256 price) public {
        if (!isReporter[msg.sender]) revert NotReporter();
        _set(feedId, price);
    }

    function initPrice(bytes32 feedId, uint256 price) external {
        if (!permissionlessInit && !isReporter[msg.sender]) revert NotReporter();
        if (reports[feedId].price != 0) revert AlreadyInitialized();
        _set(feedId, price);
    }

    function setPrices(bytes32[] calldata feedIds, uint256[] calldata prices) external {
        if (feedIds.length != prices.length) revert LengthMismatch();
        for (uint256 i; i < feedIds.length; ++i) setPrice(feedIds[i], prices[i]);
    }

    function getPrice(bytes32 feedId) external view returns (uint256 price, uint256 conf, uint256 publishTime) {
        Report memory r = reports[feedId];
        if (r.price == 0) revert NoPrice();
        return (r.price, 0, r.publishTime);
    }

    function _set(bytes32 feedId, uint256 price) private {
        if (price == 0) revert NoPrice();
        reports[feedId] = Report(price, block.timestamp);
        emit PriceSet(feedId, price, block.timestamp);
    }

    function getUpdateFee(bytes[] calldata) external pure returns (uint256) {
        return 0;
    }

    function updatePrices(bytes[] calldata) external payable {}
}
