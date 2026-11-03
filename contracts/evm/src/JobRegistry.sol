// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Owned} from "./Owned.sol";

/// @title JobRegistry (DemoService)
/// @notice Users request a deterministic job (square of a uint64). One authorised executor completes it,
///         at most once per job; the completing executionId is stored so a worker can tell "already done
///         by me" from "done by someone else" when it reconciles an uncertain outcome.
/// @dev Storage-lean for Portaldot V3 (pallet-revive charges ~0.06 tPOT per stored byte plus ~0.15 tPOT per
///      item, see docs/network-capabilities.md): one packed slot per job, one slot on completion; results
///      and hashes live in events. Holds no funds: no payable function, receive or fallback.
contract JobRegistry is Owned {
    /// @dev major * 10_000 + minor * 100 + patch
    uint256 public constant VERSION = 10_000;

    uint8 internal constant REQUESTED = 1;
    uint8 internal constant COMPLETED = 2;

    address public executor;
    uint64 public jobCount;
    /// @dev requester (160) | input (64) << 160 | status (8) << 224
    mapping(uint256 => uint256) private _job;
    mapping(uint256 => bytes32) public executionOf;

    event JobRequested(uint256 indexed jobId, address indexed requester, uint64 input, bytes32 inputHash);
    event JobCompleted(uint256 indexed jobId, bytes32 indexed executionId, uint256 result, bytes32 resultHash, address executor);
    event ExecutorChanged(address indexed previousExecutor, address indexed newExecutor);

    error NotExecutor();
    error UnknownJob();
    error AlreadyCompleted();
    error WrongResult();
    error ZeroExecutionId();

    constructor(address initialOwner, address initialExecutor) Owned(initialOwner) {
        if (initialExecutor == address(0)) revert ZeroAddress();
        executor = initialExecutor;
        emit ExecutorChanged(address(0), initialExecutor);
    }

    function setExecutor(address newExecutor) external onlyOwner {
        if (newExecutor == address(0)) revert ZeroAddress();
        emit ExecutorChanged(executor, newExecutor);
        executor = newExecutor;
    }

    function requestJob(uint64 input) external returns (uint256 jobId) {
        jobId = ++jobCount;
        _job[jobId] = uint256(uint160(msg.sender)) | (uint256(input) << 160) | (uint256(REQUESTED) << 224);
        emit JobRequested(jobId, msg.sender, input, keccak256(abi.encode(jobId, input)));
    }

    /// @notice Reverts AlreadyCompleted if the job is done; the worker then reads executionOf(jobId) and
    ///         treats the step as applied only if the stored executionId is its own.
    function completeJob(uint256 jobId, bytes32 executionId, uint256 result, bytes32 resultHash) external {
        if (msg.sender != executor) revert NotExecutor();
        if (executionId == bytes32(0)) revert ZeroExecutionId();
        uint256 w = _job[jobId];
        uint8 status = uint8(w >> 224);
        if (status == 0) revert UnknownJob();
        if (status == COMPLETED) revert AlreadyCompleted();
        uint256 input = uint64(w >> 160);
        if (result != input * input) revert WrongResult();
        _job[jobId] = (w & ~(uint256(0xff) << 224)) | (uint256(COMPLETED) << 224);
        executionOf[jobId] = executionId;
        emit JobCompleted(jobId, executionId, result, resultHash, msg.sender);
    }

    function getJob(uint256 jobId) external view returns (address requester, uint64 input, uint8 status, bytes32 executionId) {
        uint256 w = _job[jobId];
        return (address(uint160(w)), uint64(w >> 160), uint8(w >> 224), executionOf[jobId]);
    }
}
