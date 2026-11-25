// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title PriceFeed — mock price oracle on the origin chain (Base Sepolia).
/// @notice Emits a PriceUpdated event on every price change. A Reactive contract on
///         Lasna subscribes to these events; each one starts the Sentinel loop.
/// @dev    Prices are USD prices scaled by 1e8 (Chainlink-style). The feed is
///         deliberately minimal: it stands in for any real event source (a DEX
///         pool, an oracle, a lending market) whose events deserve an automated,
///         AI-assisted reaction.
contract PriceFeed {
    address public owner;

    /// @notice Latest price, scaled by 1e8.
    uint256 public price;

    /// @notice Number of price updates published so far.
    uint256 public updates;

    event PriceUpdated(uint256 price, uint256 updatedAt);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(uint256 initialPrice_) {
        owner = msg.sender;
        price = initialPrice_;
        emit PriceUpdated(initialPrice_, block.timestamp);
    }

    /// @notice Publish a new price. This is the origin event of the Sentinel loop.
    function setPrice(uint256 newPrice_) external onlyOwner {
        require(newPrice_ > 0, "price must be positive");
        price = newPrice_;
        updates += 1;
        emit PriceUpdated(newPrice_, block.timestamp);
    }

    function transferOwnership(address newOwner_) external onlyOwner {
        require(newOwner_ != address(0), "zero address");
        emit OwnershipTransferred(owner, newOwner_);
        owner = newOwner_;
    }
}
