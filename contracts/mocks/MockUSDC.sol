// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice 6-decimal test stablecoin with an open faucet. For local dev / testnets only.
contract MockUSDC is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 10_000e6;

    constructor() ERC20("Mock USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function faucet() external {
        _mint(msg.sender, FAUCET_AMOUNT);
    }
}
