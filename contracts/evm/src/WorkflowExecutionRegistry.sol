// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Owned} from "./Owned.sol";

/// @title WorkflowExecutionRegistry
/// @notice Anchors immutable workflow versions and one outcome commitment per executionId.
///         Fields are emitted in events; storage keeps one slot per version and per execution.
///         This proves registration, not that the off-chain execution was correct.
contract WorkflowExecutionRegistry is Owned {
    uint256 public constant VERSION = 10_000;

    mapping(address => bool) public isRecorder;
    /// @dev keccak256(abi.encode(workflowId, version)) => definitionHash
    mapping(bytes32 => bytes32) public definitionOf;
    /// @dev executionId => keccak256(abi.encode(workflowId, version, triggerRef, inputHash, resultHash, outcome))
    mapping(bytes32 => bytes32) public executionCommitmentOf;

    event RecorderSet(address indexed recorder, bool allowed);
    event WorkflowVersionRegistered(bytes32 indexed workflowId, uint32 indexed version, bytes32 definitionHash, address registeredBy);
    event ExecutionRecorded(bytes32 indexed executionId, bytes32 indexed workflowId, uint32 version, bytes32 triggerRef, bytes32 inputHash, bytes32 resultHash, uint8 outcome);

    error NotRecorder();
    error VersionExists();
    error UnknownVersion();
    error ExecutionExists();
    error InvalidOutcome();
    error ZeroValue();

    constructor(address initialOwner, address initialRecorder) Owned(initialOwner) {
        if (initialRecorder != address(0)) { isRecorder[initialRecorder] = true; emit RecorderSet(initialRecorder, true); }
    }

    modifier onlyRecorder() { if (!isRecorder[msg.sender]) revert NotRecorder(); _; }

    function setRecorder(address recorder, bool allowed) external onlyOwner {
        if (recorder == address(0)) revert ZeroAddress();
        isRecorder[recorder] = allowed;
        emit RecorderSet(recorder, allowed);
    }

    function registerVersion(bytes32 workflowId, uint32 version, bytes32 definitionHash) external onlyRecorder {
        if (workflowId == bytes32(0) || definitionHash == bytes32(0) || version == 0) revert ZeroValue();
        bytes32 key = keccak256(abi.encode(workflowId, version));
        if (definitionOf[key] != bytes32(0)) revert VersionExists();
        definitionOf[key] = definitionHash;
        emit WorkflowVersionRegistered(workflowId, version, definitionHash, msg.sender);
    }

    /// @param outcome 1 succeeded, 2 failed, 3 cancelled, 4 dead-lettered
    function recordExecution(bytes32 executionId, bytes32 workflowId, uint32 version, bytes32 triggerRef, bytes32 inputHash, bytes32 resultHash, uint8 outcome) external onlyRecorder {
        if (executionId == bytes32(0)) revert ZeroValue();
        if (outcome == 0 || outcome > 4) revert InvalidOutcome();
        if (definitionOf[keccak256(abi.encode(workflowId, version))] == bytes32(0)) revert UnknownVersion();
        if (executionCommitmentOf[executionId] != bytes32(0)) revert ExecutionExists();
        executionCommitmentOf[executionId] = keccak256(abi.encode(workflowId, version, triggerRef, inputHash, resultHash, outcome));
        emit ExecutionRecorded(executionId, workflowId, version, triggerRef, inputHash, resultHash, outcome);
    }
}
