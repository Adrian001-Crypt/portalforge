// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {JobRegistry} from "../src/JobRegistry.sol";
import {EvidenceRegistry} from "../src/EvidenceRegistry.sol";

/// @notice The testnet budget assumes each demo call creates exactly one new storage slot, because Portaldot V3
///         charges a deposit per new slot (docs/funding-handoff.md). This counts zero-to-nonzero writes in the EVM.
contract StorageSlotsTest is Test {
    address internal constant OWNER = address(0xA11CE);
    address internal constant EXECUTOR = address(0xE0);

    function newSlots(address target) internal returns (uint256 n) {
        Vm.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();
        for (uint256 i; i < accesses.length; ++i) {
            for (uint256 j; j < accesses[i].storageAccesses.length; ++j) {
                Vm.StorageAccess memory s = accesses[i].storageAccesses[j];
                if (s.account == target && s.isWrite && !s.reverted && s.previousValue == bytes32(0) && s.newValue != bytes32(0)) ++n;
            }
        }
    }

    function test_oneNewSlotPerDemoCall() public {
        JobRegistry jobs = new JobRegistry(OWNER, EXECUTOR);
        EvidenceRegistry evidence = new EvidenceRegistry(OWNER, EXECUTOR);

        for (uint256 i = 1; i <= 2; ++i) { // the first job costs no extra: jobCount shares the executor's slot
            vm.startStateDiffRecording();
            jobs.requestJob(12);
            assertEq(newSlots(address(jobs)), 1, "requestJob");

            vm.startStateDiffRecording();
            vm.prank(EXECUTOR);
            jobs.completeJob(i, keccak256(abi.encode("execution", i)), 144, keccak256("result"));
            assertEq(newSlots(address(jobs)), 1, "completeJob");

            vm.startStateDiffRecording();
            vm.prank(EXECUTOR);
            evidence.register(keccak256(abi.encode("evidence", i)), keccak256("content"), keccak256("execution"), keccak256("subject"));
            assertEq(newSlots(address(evidence)), 1, "register");
        }
    }
}
