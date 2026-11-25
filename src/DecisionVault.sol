// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { AbstractCallback } from "@reactive/src/base/AbstractCallback.sol";
import { IPayable } from "@reactive/src/interfaces/IPayable.sol";

/// @title DecisionVault — destination contract on Base Sepolia.
/// @notice Receives callbacks from SentinelReactive (via the Reactive callback
///         proxy) whenever the watched price moves. Each callback opens a
///         decision request carrying the rolling price window; the off-chain
///         AI agent classifies the window with a neural network and posts its
///         decision back here, and this contract executes the protective
///         action (hold / hedge / exit) on the vault's mock position.
/// @dev    Callback billing: this contract pays the callback proxy for callback
///         execution in Base Sepolia ETH, so it must stay funded.
contract DecisionVault is AbstractCallback {
    /// @notice Callback proxy on Base Sepolia (see docs/RULES.md).
    address public constant BASE_SEPOLIA_CALLBACK_PROXY =
        0x476F44b11F5C942c58f4c8E3d0300E5710743585;

    uint8 public constant ACTION_HOLD = 0;
    uint8 public constant ACTION_HEDGE = 1;
    uint8 public constant ACTION_EXIT = 2;

    enum State {
        Exposed,
        Hedged,
        Exited
    }

    struct Decision {
        uint256 price;
        uint256 originTx;
        uint8 action;
        uint16 confidenceBps;
        bool requested;
        bool decided;
    }

    address public owner;
    address public agent;

    State public state;
    /// @notice Share of the position currently hedged, in basis points.
    uint256 public hedgeRatioBps;
    /// @notice Next decision request id (ids start at 1).
    uint256 public nextId = 1;
    /// @notice Total decisions executed by the agent.
    uint256 public decisionsExecuted;
    uint8 public lastAction;
    uint16 public lastConfidenceBps;

    mapping(uint256 => Decision) public decisions;

    event DecisionRequested(
        uint256 indexed id,
        uint256 price,
        uint256 originTx,
        uint256[8] window
    );
    event ActionExecuted(
        uint256 indexed id,
        uint8 action,
        uint16 confidenceBps,
        uint256 hedgeRatioBps,
        State state
    );
    event AgentSet(address indexed agent);
    event ProtectionReset();
    event DebtCovered();

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyAgent() {
        require(msg.sender == agent, "not agent");
        _;
    }

    /// @param reactive_ The SentinelReactive contract on Lasna; the only
    ///        reactive contract whose callbacks this vault accepts. Immutable
    ///        inside AbstractCallback — a wrong value means redeploying.
    /// @param agent_ The AI agent's signing address.
    constructor(address reactive_, address agent_)
        payable
        AbstractCallback(IPayable(payable(BASE_SEPOLIA_CALLBACK_PROXY)), reactive_)
    {
        owner = msg.sender;
        agent = agent_;
        state = State.Exposed;
    }

    /// @notice Callback entry point, invoked by the Reactive callback proxy.
    /// @dev    The first argument is overwritten by the network with the
    ///         requesting reactive contract's address; both guards together
    ///         prove the call came through the network from our contract.
    function requestDecision(
        address reactive_,
        uint256 latestPrice_,
        uint256[8] calldata window_,
        uint256 originTx_
    ) external onlyServiceProvider onlyCallbackSender(reactive_) {
        uint256 id = nextId++;
        decisions[id] = Decision({
            price: latestPrice_,
            originTx: originTx_,
            action: 0,
            confidenceBps: 0,
            requested: true,
            decided: false
        });
        emit DecisionRequested(id, latestPrice_, originTx_, window_);
    }

    /// @notice Post the AI agent's decision for a pending request and execute it.
    /// @param id_ Decision request id from DecisionRequested.
    /// @param action_ ACTION_HOLD, ACTION_HEDGE or ACTION_EXIT.
    /// @param confidenceBps_ Model confidence for the chosen action, 0–10000.
    function submitDecision(uint256 id_, uint8 action_, uint16 confidenceBps_)
        external
        onlyAgent
    {
        Decision storage d = decisions[id_];
        require(d.requested, "unknown request");
        require(!d.decided, "already decided");
        require(action_ <= ACTION_EXIT, "bad action");
        require(confidenceBps_ <= 10_000, "bad confidence");

        d.action = action_;
        d.confidenceBps = confidenceBps_;
        d.decided = true;
        decisionsExecuted += 1;
        lastAction = action_;
        lastConfidenceBps = confidenceBps_;

        if (action_ == ACTION_HEDGE && state == State.Exposed) {
            hedgeRatioBps = 5_000;
            state = State.Hedged;
        } else if (action_ == ACTION_EXIT && state != State.Exited) {
            hedgeRatioBps = 10_000;
            state = State.Exited;
        }
        emit ActionExecuted(id_, action_, confidenceBps_, hedgeRatioBps, state);
    }

    /// @notice Rotate the agent address. Owner-only.
    function setAgent(address agent_) external onlyOwner {
        agent = agent_;
        emit AgentSet(agent_);
    }

    /// @notice Reset the protection state so a fresh demo run can start from
    ///         fully exposed. Owner-only.
    function resetProtection() external onlyOwner {
        state = State.Exposed;
        hedgeRatioBps = 0;
        emit ProtectionReset();
    }

    /// @notice Settle any outstanding debt to the callback proxy from this
    ///         contract's own balance.
    function coverDebt() external {
        _coverDebt();
        emit DebtCovered();
    }
}
