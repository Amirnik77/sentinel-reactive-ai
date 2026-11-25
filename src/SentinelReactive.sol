// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { AbstractReactive } from "@reactive/src/base/AbstractReactive.sol";
import { IReactive } from "@reactive/src/interfaces/IReactive.sol";
import { ISystemContract } from "@reactive/src/interfaces/ISystemContract.sol";

/// @title SentinelReactive — the Reactive leg of Sentinel, deployed on Lasna.
/// @notice Subscribes to PriceUpdated events from a PriceFeed on Base Sepolia.
///         For every event it maintains a rolling window of the last WINDOW_SIZE
///         prices on-chain and requests a callback to the DecisionVault on
///         Base Sepolia, carrying the window the AI agent will classify.
/// @dev    The reactive contract does real work, not just forwarding: it keeps
///         the price window, counts updates, and stamps each callback with the
///         origin transaction hash so the whole loop is traceable end to end.
contract SentinelReactive is AbstractReactive {
    uint256 public constant WINDOW_SIZE = 8;
    uint256 public constant DESTINATION_CHAIN_ID = 84532; // Base Sepolia
    uint64 public constant CALLBACK_GAS_LIMIT = 600_000;

    bytes32 public constant PRICE_UPDATED_TOPIC =
        keccak256("PriceUpdated(uint256,uint256)");

    address public owner;
    address public feed;
    address public vault;

    /// @notice Rolling window of the most recent prices, oldest first.
    uint256[WINDOW_SIZE] public window;
    /// @notice Total PriceUpdated events processed.
    uint256 public reactions;
    /// @notice Most recent price seen.
    uint256 public lastPrice;
    /// @notice Origin tx hash of the most recent reaction (as uint256, per LogRecord).
    uint256 public lastOriginTx;

    event Reaction(uint256 indexed originTx, uint256 price, uint256 seq);
    event VaultSet(address indexed vault);
    event DebtCovered();

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    /// @param feed_ PriceFeed address on Base Sepolia to subscribe to.
    constructor(address feed_) payable {
        owner = msg.sender;
        feed = feed_;
        SYSTEM.subscribe(
            DESTINATION_CHAIN_ID,
            feed_,
            uint256(PRICE_UPDATED_TOPIC),
            REACTIVE_IGNORE,
            REACTIVE_IGNORE,
            REACTIVE_IGNORE
        );
    }

    /// @notice Set the DecisionVault that callbacks are sent to. Owner-only;
    ///         called once after the vault is deployed (it needs this
    ///         contract's address immutably at construction).
    function setVault(address vault_) external onlyOwner {
        vault = vault_;
        emit VaultSet(vault_);
    }

    /// @notice Entry point called by the system contract for every matching log.
    function react(IReactive.LogRecord calldata log_) external onlySystem {
        if (log_.topic0 != uint256(PRICE_UPDATED_TOPIC)) {
            return; // Not ours: never revert as a filter, just ignore.
        }
        (uint256 newPrice, ) = abi.decode(log_.data, (uint256, uint256));

        // Shift the rolling window left and append the new price.
        for (uint256 i = 0; i < WINDOW_SIZE - 1; i++) {
            window[i] = window[i + 1];
        }
        window[WINDOW_SIZE - 1] = newPrice;
        lastPrice = newPrice;
        lastOriginTx = log_.txHash;
        reactions += 1;

        emit Reaction(log_.txHash, newPrice, reactions);

        address vault_ = vault;
        if (vault_ == address(0)) {
            return; // Window still warms up before the vault is wired.
        }

        bytes memory payload = abi.encodeWithSignature(
            "requestDecision(address,uint256,uint256[8],uint256)",
            address(0), // replaced by the network with this contract's address
            newPrice,
            window,
            log_.txHash
        );
        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: DESTINATION_CHAIN_ID,
                recipient: vault_,
                gasLimit: CALLBACK_GAS_LIMIT,
                payload: payload
            })
        );
    }

    /// @notice Read the current rolling window.
    function getWindow() external view returns (uint256[WINDOW_SIZE] memory) {
        return window;
    }

    /// @notice Settle any outstanding debt to the system contract from this
    ///         contract's own balance.
    function coverDebt() external {
        _coverDebt();
        emit DebtCovered();
    }

    /// @notice Withdraw surplus lREACT. Owner-only.
    function withdraw(uint256 amount_) external onlyOwner {
        require(amount_ <= address(this).balance, "insufficient");
        (bool ok, ) = payable(owner).call{ value: amount_ }("");
        require(ok, "transfer failed");
    }
}
