// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {JobRegistry} from "../src/JobRegistry.sol";
import {Owned} from "../src/Owned.sol";

contract JobRegistryTest is Test {
    JobRegistry reg;
    address owner = address(0xA11CE);
    address exec = address(0xE0E0);
    address user = address(0xB0B);
    bytes32 constant EID = keccak256("exec-1");

    event JobRequested(uint256 indexed jobId, address indexed requester, uint64 input, bytes32 inputHash);
    event JobCompleted(uint256 indexed jobId, bytes32 indexed executionId, uint256 result, bytes32 resultHash, address executor);

    function setUp() public { reg = new JobRegistry(owner, exec); }

    function test_requestEmitsAndStores() public {
        vm.expectEmit(true, true, false, true);
        emit JobRequested(1, user, 12, keccak256(abi.encode(uint256(1), uint64(12))));
        vm.prank(user);
        uint256 id = reg.requestJob(12);
        assertEq(id, 1);
        (address requester, uint64 input, uint8 status, bytes32 eid) = reg.getJob(1);
        assertEq(requester, user);
        assertEq(input, 12);
        assertEq(status, 1);
        assertEq(eid, bytes32(0));
        assertEq(reg.jobCount(), 1);
    }

    function test_completeOnceOnly() public {
        vm.prank(user); reg.requestJob(7);
        vm.expectEmit(true, true, false, true);
        emit JobCompleted(1, EID, 49, bytes32(uint256(1)), exec);
        vm.prank(exec); reg.completeJob(1, EID, 49, bytes32(uint256(1)));
        (, uint64 input, uint8 status, bytes32 eid) = reg.getJob(1);
        assertEq(status, 2);
        assertEq(input, 7); // packing preserved
        assertEq(eid, EID);
        vm.prank(exec);
        vm.expectRevert(JobRegistry.AlreadyCompleted.selector);
        reg.completeJob(1, keccak256("exec-2"), 49, bytes32(uint256(1)));
        assertEq(reg.executionOf(1), EID); // second attempt changed nothing
    }

    function test_onlyExecutor() public {
        vm.prank(user); reg.requestJob(2);
        vm.prank(user);
        vm.expectRevert(JobRegistry.NotExecutor.selector);
        reg.completeJob(1, EID, 4, bytes32(0));
    }

    function test_wrongResultRejected() public {
        vm.prank(user); reg.requestJob(5);
        vm.prank(exec);
        vm.expectRevert(JobRegistry.WrongResult.selector);
        reg.completeJob(1, EID, 26, bytes32(0));
    }

    function test_unknownJobAndZeroExecution() public {
        vm.prank(exec);
        vm.expectRevert(JobRegistry.UnknownJob.selector);
        reg.completeJob(99, EID, 0, bytes32(0));
        vm.prank(user); reg.requestJob(1);
        vm.prank(exec);
        vm.expectRevert(JobRegistry.ZeroExecutionId.selector);
        reg.completeJob(1, bytes32(0), 1, bytes32(0));
    }

    function test_maxInputSquareFits() public {
        vm.prank(user); reg.requestJob(type(uint64).max);
        vm.prank(exec);
        reg.completeJob(1, EID, uint256(type(uint64).max) * uint256(type(uint64).max), bytes32(0));
        (address requester,,,) = reg.getJob(1);
        assertEq(requester, user);
    }

    function test_executorRotationOwnerOnly() public {
        vm.prank(user);
        vm.expectRevert(Owned.NotOwner.selector);
        reg.setExecutor(user);
        vm.prank(owner); reg.setExecutor(user);
        assertEq(reg.executor(), user);
        vm.prank(owner);
        vm.expectRevert(Owned.ZeroAddress.selector);
        reg.setExecutor(address(0));
        // the old executor lost its right immediately
        vm.prank(user); reg.requestJob(3);
        vm.prank(exec);
        vm.expectRevert(JobRegistry.NotExecutor.selector);
        reg.completeJob(1, EID, 9, bytes32(0));
    }

    function test_rejectsValue() public {
        vm.deal(user, 1 ether);
        vm.prank(user);
        (bool ok,) = address(reg).call{value: 1 wei}("");
        assertFalse(ok);
        vm.prank(user);
        (ok,) = address(reg).call{value: 1 wei}(abi.encodeCall(JobRegistry.requestJob, (1)));
        assertFalse(ok);
        assertEq(address(reg).balance, 0);
    }

    function test_twoStepOwnership() public {
        vm.prank(owner); reg.transferOwnership(user);
        assertEq(reg.owner(), owner);
        vm.prank(exec);
        vm.expectRevert(Owned.NotPendingOwner.selector);
        reg.acceptOwnership();
        vm.prank(user); reg.acceptOwnership();
        assertEq(reg.owner(), user);
        assertEq(reg.pendingOwner(), address(0));
    }

    function testFuzz_packingAndSquare(address requester, uint64 input, uint256 result) public {
        vm.assume(requester != address(0));
        vm.prank(requester); reg.requestJob(input);
        (address r, uint64 i, uint8 s,) = reg.getJob(1);
        assertEq(r, requester); assertEq(i, input); assertEq(s, 1);
        uint256 sq = uint256(input) * uint256(input);
        vm.prank(exec);
        if (result != sq) vm.expectRevert(JobRegistry.WrongResult.selector);
        reg.completeJob(1, EID, result, bytes32(0));
    }
}
