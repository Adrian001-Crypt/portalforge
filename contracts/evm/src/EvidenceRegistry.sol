// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Owned} from "./Owned.sol";

/// @title EvidenceRegistry
/// @notice Binds a content hash to a unique evidence id. Storage keeps one commitment slot per id:
///         keccak256(abi.encode(contentHash, kind, subject, writer)); revocation overwrites it with its
///         bitwise complement. The full fields are in EvidenceRegistered, so a verifier recomputes the
///         commitment from the event and compares it with storage.
/// @dev A registration proves that `writer` bound `contentHash` to `evidenceId` at a block. It does not
///      prove the content is true. Holds no funds.
contract EvidenceRegistry is Owned {
    uint256 public constant VERSION = 10_000;

    mapping(address => bool) public isWriter;
    mapping(bytes32 => bytes32) public commitmentOf;

    event WriterSet(address indexed writer, bool allowed);
    event EvidenceRegistered(bytes32 indexed evidenceId, bytes32 indexed kind, bytes32 indexed subject, bytes32 contentHash, address writer);
    event EvidenceRevoked(bytes32 indexed evidenceId, address indexed writer, string reason);

    error NotWriter();
    error EvidenceExists();
    error NotOriginalRecord();
    error ZeroValue();
    error ReasonTooLong();

    constructor(address initialOwner, address initialWriter) Owned(initialOwner) {
        if (initialWriter != address(0)) { isWriter[initialWriter] = true; emit WriterSet(initialWriter, true); }
    }

    function setWriter(address writer, bool allowed) external onlyOwner {
        if (writer == address(0)) revert ZeroAddress();
        isWriter[writer] = allowed;
        emit WriterSet(writer, allowed);
    }

    function commitment(bytes32 contentHash, bytes32 kind, bytes32 subject, address writer) public pure returns (bytes32) {
        return keccak256(abi.encode(contentHash, kind, subject, writer));
    }

    function register(bytes32 evidenceId, bytes32 kind, bytes32 subject, bytes32 contentHash) external {
        if (!isWriter[msg.sender]) revert NotWriter();
        if (evidenceId == bytes32(0) || contentHash == bytes32(0) || kind == bytes32(0)) revert ZeroValue();
        if (commitmentOf[evidenceId] != bytes32(0)) revert EvidenceExists();
        commitmentOf[evidenceId] = commitment(contentHash, kind, subject, msg.sender);
        emit EvidenceRegistered(evidenceId, kind, subject, contentHash, msg.sender);
    }

    /// @notice Only the original writer can revoke (proved by recomputing the commitment with msg.sender),
    ///         even after being removed from the writer allowlist. Revocation is permanent.
    function revoke(bytes32 evidenceId, bytes32 kind, bytes32 subject, bytes32 contentHash, string calldata reason) external {
        if (bytes(reason).length > 256) revert ReasonTooLong();
        if (commitmentOf[evidenceId] != commitment(contentHash, kind, subject, msg.sender)) revert NotOriginalRecord();
        commitmentOf[evidenceId] = ~commitmentOf[evidenceId];
        emit EvidenceRevoked(evidenceId, msg.sender, reason);
    }

    /// @return 0 unknown id, 1 active and matching, 2 revoked and matching, 3 id exists but fields do not match
    function status(bytes32 evidenceId, bytes32 kind, bytes32 subject, bytes32 contentHash, address writer) external view returns (uint8) {
        bytes32 s = commitmentOf[evidenceId];
        if (s == bytes32(0)) return 0;
        bytes32 c = commitment(contentHash, kind, subject, writer);
        if (s == c) return 1;
        if (s == ~c) return 2;
        return 3;
    }
}
