// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {RepairEscrow} from "../src/RepairEscrow.sol";

/// Drives random sequences of lifecycle calls by legitimate and illegitimate actors.
contract EscrowHandler is Test {
    RepairEscrow public escrow;
    address public sponsor = makeAddr("inv-sponsor");
    address public provider = makeAddr("inv-provider");
    address public stranger = makeAddr("inv-stranger");
    uint256 public verifierKey = 0xBEEF;
    uint256 public strangerKey = 0xD00D;
    uint256 public totalPaidOut;

    constructor(RepairEscrow e) {
        escrow = e;
        vm.deal(sponsor, 1_000_000 ether);
    }

    function _pick(uint256 seed) internal view returns (uint256) {
        uint256 n = escrow.projectCount();
        return n == 0 ? 0 : (seed % n) + 1;
    }

    function create(uint96 amount, uint32 ttl) external {
        amount = uint96(bound(amount, 1, 100 ether));
        ttl = uint32(bound(ttl, 1 hours, 60 days));
        vm.prank(sponsor);
        escrow.createProject(provider, vm.addr(verifierKey), amount, keccak256("t"), uint64(block.timestamp + ttl), 0);
    }

    function fund(uint256 seed) external {
        uint256 id = _pick(seed);
        if (id == 0) return;
        RepairEscrow.Project memory p = escrow.getProject(id);
        vm.prank(sponsor);
        try escrow.fund{value: p.amount}(id) {} catch {}
    }

    function accept(uint256 seed) external {
        uint256 id = _pick(seed);
        if (id == 0) return;
        vm.prank(provider);
        try escrow.acceptAssignment(id) {} catch {}
    }

    function submit(uint256 seed, bytes32 h) external {
        uint256 id = _pick(seed);
        if (id == 0 || h == bytes32(0)) return;
        vm.prank(provider);
        try escrow.submitEvidence(id, h) {} catch {}
    }

    function decide(uint256 seed, uint8 outcome, bool useStrangerKey) external {
        uint256 id = _pick(seed);
        if (id == 0) return;
        RepairEscrow.Project memory p = escrow.getProject(id);
        RepairEscrow.Outcome o = RepairEscrow.Outcome(bound(outcome, 1, 4));
        uint64 dl = uint64(block.timestamp + 1 hours);
        bytes32 d = escrow.decisionDigest(id, p.round, p.evidenceHash, o, bytes32(0), dl);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(useStrangerKey ? strangerKey : verifierKey, d);
        try escrow.recordDecision(id, p.round, p.evidenceHash, o, bytes32(0), dl, abi.encodePacked(r, s, v)) {} catch {}
    }

    function release(uint256 seed) external {
        uint256 id = _pick(seed);
        if (id == 0) return;
        uint256 before = provider.balance;
        vm.prank(stranger);
        try escrow.releasePayment(id) {
            totalPaidOut += provider.balance - before;
        } catch {}
    }

    function cancel(uint256 seed) external {
        uint256 id = _pick(seed);
        if (id == 0) return;
        vm.prank(sponsor);
        try escrow.cancel(id) {} catch {}
    }

    function refund(uint256 seed) external {
        uint256 id = _pick(seed);
        if (id == 0) return;
        vm.prank(sponsor);
        try escrow.refundExpired(id) {} catch {}
    }

    function strangerAttacks(uint256 seed) external {
        uint256 id = _pick(seed);
        if (id == 0) return;
        vm.startPrank(stranger);
        try escrow.cancel(id) {} catch {}
        try escrow.refundExpired(id) {} catch {}
        try escrow.acceptAssignment(id) {} catch {}
        try escrow.submitEvidence(id, keccak256("x")) {} catch {}
        vm.stopPrank();
    }

    function warp(uint32 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 10 days));
    }
}

contract RepairEscrowInvariantTest is Test {
    RepairEscrow escrow;
    EscrowHandler handler;

    function setUp() public {
        address admin = makeAddr("inv-admin");
        escrow = new RepairEscrow(admin);
        handler = new EscrowHandler(escrow);
        vm.startPrank(admin);
        escrow.setProviderApproval(handler.provider(), true);
        escrow.setVerifierApproval(vm.addr(handler.verifierKey()), true);
        vm.stopPrank();
        targetContract(address(handler));
    }

    /// Escrow balance always equals the sum of amounts held for live (funded, unsettled) projects.
    function invariant_BalanceMatchesLiveEscrow() public view {
        uint256 held;
        uint256 n = escrow.projectCount();
        for (uint256 i = 1; i <= n; i++) {
            RepairEscrow.Project memory p = escrow.getProject(i);
            RepairEscrow.State s = p.state;
            if (
                s == RepairEscrow.State.Funded || s == RepairEscrow.State.Assigned || s == RepairEscrow.State.Submitted
                    || s == RepairEscrow.State.Verified || s == RepairEscrow.State.Rejected
                    || s == RepairEscrow.State.Inconclusive || s == RepairEscrow.State.EvidenceRequested
                    || s == RepairEscrow.State.Disputed
            ) held += p.amount;
        }
        assertEq(address(escrow).balance, held);
    }

    /// The provider can never have received more than the sum of amounts of Paid projects.
    function invariant_PayoutsOnlyForPaidProjects() public view {
        uint256 paid;
        uint256 n = escrow.projectCount();
        for (uint256 i = 1; i <= n; i++) {
            RepairEscrow.Project memory p = escrow.getProject(i);
            if (p.state == RepairEscrow.State.Paid) paid += p.amount;
        }
        assertEq(handler.totalPaidOut(), paid);
        assertEq(handler.provider().balance, paid);
    }
}
