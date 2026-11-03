// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EvidenceRegistry} from "../src/EvidenceRegistry.sol";
import {WorkflowExecutionRegistry} from "../src/WorkflowExecutionRegistry.sol";
import {Owned} from "../src/Owned.sol";

contract EvidenceRegistryTest is Test {
    EvidenceRegistry ev;
    address owner = address(0xA11CE);
    address writer = address(0xE0E0);
    address other = address(0xB0B);
    bytes32 constant ID = keccak256("evidence-1");
    bytes32 constant KIND = keccak256("execution-result");
    bytes32 constant SUBJ = bytes32(uint256(7));
    bytes32 constant H = keccak256("content");

    event EvidenceRegistered(bytes32 indexed evidenceId, bytes32 indexed kind, bytes32 indexed subject, bytes32 contentHash, address writer);

    function setUp() public { ev = new EvidenceRegistry(owner, writer); }

    function test_registerEmitsAndCommits() public {
        vm.expectEmit(true, true, true, true);
        emit EvidenceRegistered(ID, KIND, SUBJ, H, writer);
        vm.prank(writer); ev.register(ID, KIND, SUBJ, H);
        assertEq(ev.commitmentOf(ID), keccak256(abi.encode(H, KIND, SUBJ, writer)));
        assertEq(ev.status(ID, KIND, SUBJ, H, writer), 1);
        assertEq(ev.status(ID, KIND, SUBJ, keccak256("other"), writer), 3);
        assertEq(ev.status(ID, KIND, SUBJ, H, other), 3);
        assertEq(ev.status(keccak256("nope"), KIND, SUBJ, H, writer), 0);
    }

    function test_duplicateRejected() public {
        vm.startPrank(writer);
        ev.register(ID, KIND, SUBJ, H);
        vm.expectRevert(EvidenceRegistry.EvidenceExists.selector);
        ev.register(ID, KIND, SUBJ, keccak256("b"));
        vm.stopPrank();
    }

    function test_onlyWriterRegisters() public {
        vm.prank(other);
        vm.expectRevert(EvidenceRegistry.NotWriter.selector);
        ev.register(ID, KIND, SUBJ, H);
    }

    function test_zeroValuesRejected() public {
        vm.startPrank(writer);
        vm.expectRevert(EvidenceRegistry.ZeroValue.selector);
        ev.register(bytes32(0), KIND, SUBJ, H);
        vm.expectRevert(EvidenceRegistry.ZeroValue.selector);
        ev.register(ID, KIND, SUBJ, bytes32(0));
        vm.expectRevert(EvidenceRegistry.ZeroValue.selector);
        ev.register(ID, bytes32(0), SUBJ, H);
        vm.stopPrank();
    }

    function test_revokeByOriginalWriterOnly() public {
        vm.prank(writer); ev.register(ID, KIND, SUBJ, H);
        vm.prank(owner);
        vm.expectRevert(EvidenceRegistry.NotOriginalRecord.selector);
        ev.revoke(ID, KIND, SUBJ, H, "owner cannot revoke others");
        vm.prank(writer);
        vm.expectRevert(EvidenceRegistry.NotOriginalRecord.selector);
        ev.revoke(ID, KIND, SUBJ, keccak256("wrong"), "wrong fields");
        vm.prank(owner); ev.setWriter(writer, false); // removed writer can still revoke its own record
        vm.prank(writer); ev.revoke(ID, KIND, SUBJ, H, "bad report");
        assertEq(ev.status(ID, KIND, SUBJ, H, writer), 2);
        vm.prank(writer);
        vm.expectRevert(EvidenceRegistry.NotOriginalRecord.selector);
        ev.revoke(ID, KIND, SUBJ, H, "again");
        // revoked id cannot be re-registered
        vm.prank(owner); ev.setWriter(writer, true);
        vm.prank(writer);
        vm.expectRevert(EvidenceRegistry.EvidenceExists.selector);
        ev.register(ID, KIND, SUBJ, H);
    }

    function test_revokeUnknownAndLongReason() public {
        vm.prank(writer);
        vm.expectRevert(EvidenceRegistry.NotOriginalRecord.selector);
        ev.revoke(ID, KIND, SUBJ, H, "x");
        vm.prank(writer); ev.register(ID, KIND, SUBJ, H);
        bytes memory long = new bytes(257);
        vm.prank(writer);
        vm.expectRevert(EvidenceRegistry.ReasonTooLong.selector);
        ev.revoke(ID, KIND, SUBJ, H, string(long));
    }

    function test_writerManagementOwnerOnly() public {
        vm.prank(other);
        vm.expectRevert(Owned.NotOwner.selector);
        ev.setWriter(other, true);
    }

    function test_rejectsValue() public {
        vm.deal(other, 1 ether);
        vm.prank(other);
        (bool ok,) = address(ev).call{value: 1}("");
        assertFalse(ok);
    }
}

contract WorkflowExecutionRegistryTest is Test {
    WorkflowExecutionRegistry wr;
    address owner = address(0xA11CE);
    address rec = address(0xE0E0);
    bytes32 constant WF = keccak256("wf");
    bytes32 constant EID = keccak256("exec");

    function setUp() public { wr = new WorkflowExecutionRegistry(owner, rec); }

    function test_versionImmutable() public {
        vm.startPrank(rec);
        wr.registerVersion(WF, 1, keccak256("def1"));
        vm.expectRevert(WorkflowExecutionRegistry.VersionExists.selector);
        wr.registerVersion(WF, 1, keccak256("def1-changed"));
        vm.stopPrank();
        assertEq(wr.definitionOf(keccak256(abi.encode(WF, uint32(1)))), keccak256("def1"));
    }

    function test_recordOnceAgainstKnownVersion() public {
        vm.startPrank(rec);
        vm.expectRevert(WorkflowExecutionRegistry.UnknownVersion.selector);
        wr.recordExecution(EID, WF, 1, 0, 0, 0, 1);
        wr.registerVersion(WF, 1, keccak256("def1"));
        wr.recordExecution(EID, WF, 1, bytes32(uint256(5)), keccak256("in"), keccak256("out"), 1);
        vm.expectRevert(WorkflowExecutionRegistry.ExecutionExists.selector);
        wr.recordExecution(EID, WF, 1, 0, 0, 0, 2);
        vm.expectRevert(WorkflowExecutionRegistry.InvalidOutcome.selector);
        wr.recordExecution(keccak256("e2"), WF, 1, 0, 0, 0, 0);
        vm.expectRevert(WorkflowExecutionRegistry.InvalidOutcome.selector);
        wr.recordExecution(keccak256("e2"), WF, 1, 0, 0, 0, 5);
        vm.stopPrank();
        assertEq(wr.executionCommitmentOf(EID), keccak256(abi.encode(WF, uint32(1), bytes32(uint256(5)), keccak256("in"), keccak256("out"), uint8(1))));
    }

    function test_onlyRecorder() public {
        vm.expectRevert(WorkflowExecutionRegistry.NotRecorder.selector);
        wr.registerVersion(WF, 1, keccak256("def"));
        vm.prank(owner); wr.setRecorder(address(this), true);
        wr.registerVersion(WF, 1, keccak256("def"));
    }
}
