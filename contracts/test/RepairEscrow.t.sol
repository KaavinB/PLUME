// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {RepairEscrow} from "../src/RepairEscrow.sol";

contract RevertingReceiver {
    receive() external payable {
        revert("no");
    }
}

/// Provider contract that tries to re-enter the escrow when paid.
contract ReentrantProvider {
    RepairEscrow public escrow;
    uint256 public projectId;
    bool public attempted;
    bool public reentrySucceeded;

    constructor(RepairEscrow e) {
        escrow = e;
    }

    function setProject(uint256 id) external {
        projectId = id;
    }

    function accept() external {
        escrow.acceptAssignment(projectId);
    }

    function submit(bytes32 h) external {
        escrow.submitEvidence(projectId, h);
    }

    receive() external payable {
        if (!attempted) {
            attempted = true;
            try escrow.releasePayment(projectId) {
                reentrySucceeded = true;
            } catch {}
        }
    }
}

contract RepairEscrowTest is Test {
    RepairEscrow escrow;

    address admin = makeAddr("admin");
    address sponsor = makeAddr("sponsor");
    address provider = makeAddr("provider");
    uint256 verifierKey = 0xA11CE;
    address verifier;
    uint256 attackerKey = 0xBAD;
    address attacker;

    uint256 constant AMOUNT = 2 ether;
    bytes32 constant TERMS = keccak256("terms-v1");
    bytes32 constant EVIDENCE = keccak256("evidence-bundle-1");
    bytes32 constant REPORT = keccak256("verification-report-1");

    function setUp() public {
        verifier = vm.addr(verifierKey);
        attacker = vm.addr(attackerKey);
        escrow = new RepairEscrow(admin);
        vm.startPrank(admin);
        escrow.setProviderApproval(provider, true);
        escrow.setVerifierApproval(verifier, true);
        vm.stopPrank();
        vm.deal(sponsor, 100 ether);
        vm.deal(attacker, 100 ether);
    }

    // ------------------------------------------------------------------ helpers
    function _create() internal returns (uint256 id) {
        vm.prank(sponsor);
        id = escrow.createProject(provider, verifier, AMOUNT, TERMS, uint64(block.timestamp + 30 days), 0);
    }

    function _createFunded() internal returns (uint256 id) {
        id = _create();
        vm.prank(sponsor);
        escrow.fund{value: AMOUNT}(id);
    }

    function _createSubmitted() internal returns (uint256 id) {
        id = _createFunded();
        vm.prank(provider);
        escrow.acceptAssignment(id);
        vm.prank(provider);
        escrow.submitEvidence(id, EVIDENCE);
    }

    function _sign(uint256 key, uint256 id, uint32 round, bytes32 ev, RepairEscrow.Outcome o, uint64 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = escrow.decisionDigest(id, round, ev, o, REPORT, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _decide(uint256 id, RepairEscrow.Outcome o) internal {
        RepairEscrow.Project memory p = escrow.getProject(id);
        uint64 dl = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sign(verifierKey, id, p.round, p.evidenceHash, o, dl);
        escrow.recordDecision(id, p.round, p.evidenceHash, o, REPORT, dl, sig);
    }

    function _state(uint256 id) internal view returns (RepairEscrow.State) {
        return escrow.getProject(id).state;
    }

    // ------------------------------------------------------------------ happy path
    function test_FullLifecycle_PaysProvider() public {
        uint256 id = _createSubmitted();
        _decide(id, RepairEscrow.Outcome.Verified);
        assertEq(uint8(_state(id)), uint8(RepairEscrow.State.Verified));
        uint256 before = provider.balance;
        escrow.releasePayment(id);
        assertEq(provider.balance - before, AMOUNT);
        assertEq(uint8(_state(id)), uint8(RepairEscrow.State.Paid));
        assertEq(address(escrow).balance, 0);
    }

    // ------------------------------------------------------------------ creation & funding
    function test_Create_RejectsUnapprovedParticipants() public {
        vm.prank(sponsor);
        vm.expectRevert(abi.encodeWithSelector(RepairEscrow.ParticipantNotApproved.selector, attacker));
        escrow.createProject(attacker, verifier, AMOUNT, TERMS, uint64(block.timestamp + 1 days), 0);
        vm.prank(sponsor);
        vm.expectRevert(abi.encodeWithSelector(RepairEscrow.ParticipantNotApproved.selector, attacker));
        escrow.createProject(provider, attacker, AMOUNT, TERMS, uint64(block.timestamp + 1 days), 0);
    }

    function test_Create_RequiresIndependentRoles() public {
        vm.prank(admin);
        escrow.setVerifierApproval(provider, true);
        vm.prank(sponsor);
        vm.expectRevert(RepairEscrow.InvalidParameters.selector);
        escrow.createProject(provider, provider, AMOUNT, TERMS, uint64(block.timestamp + 1 days), 0);
        vm.prank(verifier);
        vm.expectRevert(RepairEscrow.InvalidParameters.selector);
        escrow.createProject(provider, verifier, AMOUNT, TERMS, uint64(block.timestamp + 1 days), 0);
    }

    function test_Create_RejectsBadParameters() public {
        vm.startPrank(sponsor);
        vm.expectRevert(RepairEscrow.InvalidParameters.selector);
        escrow.createProject(provider, verifier, 0, TERMS, uint64(block.timestamp + 1 days), 0);
        vm.expectRevert(RepairEscrow.InvalidParameters.selector);
        escrow.createProject(provider, verifier, AMOUNT, bytes32(0), uint64(block.timestamp + 1 days), 0);
        vm.expectRevert(RepairEscrow.InvalidParameters.selector);
        escrow.createProject(provider, verifier, AMOUNT, TERMS, uint64(block.timestamp), 0);
        vm.expectRevert(RepairEscrow.InvalidParameters.selector);
        escrow.createProject(provider, verifier, AMOUNT, TERMS, uint64(block.timestamp + 1 days), 31 days);
        vm.stopPrank();
    }

    function test_Fund_WrongAmountFails() public {
        uint256 id = _create();
        vm.prank(sponsor);
        vm.expectRevert(RepairEscrow.WrongAmount.selector);
        escrow.fund{value: AMOUNT - 1}(id);
    }

    function test_Fund_OnlySponsor() public {
        uint256 id = _create();
        vm.prank(attacker);
        vm.expectRevert(RepairEscrow.NotAuthorized.selector);
        escrow.fund{value: AMOUNT}(id);
    }

    function test_Fund_DoubleFundingRejected() public {
        uint256 id = _createFunded();
        vm.prank(sponsor);
        vm.expectRevert(abi.encodeWithSelector(RepairEscrow.InvalidState.selector, RepairEscrow.State.Funded));
        escrow.fund{value: AMOUNT}(id);
    }

    function test_Fund_UnknownProject() public {
        vm.prank(sponsor);
        vm.expectRevert(RepairEscrow.InvalidParameters.selector);
        escrow.fund{value: AMOUNT}(999);
    }

    // ------------------------------------------------------------------ assignment & evidence
    function test_Accept_OnlyDesignatedProvider() public {
        uint256 id = _createFunded();
        vm.prank(attacker);
        vm.expectRevert(RepairEscrow.NotAuthorized.selector);
        escrow.acceptAssignment(id);
    }

    function test_Accept_RequiresFunding() public {
        uint256 id = _create();
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(RepairEscrow.InvalidState.selector, RepairEscrow.State.Open));
        escrow.acceptAssignment(id);
    }

    function test_SubmitEvidence_OnlyProviderAfterAssignment() public {
        uint256 id = _createFunded();
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(RepairEscrow.InvalidState.selector, RepairEscrow.State.Funded));
        escrow.submitEvidence(id, EVIDENCE);
        vm.prank(provider);
        escrow.acceptAssignment(id);
        vm.prank(attacker);
        vm.expectRevert(RepairEscrow.NotAuthorized.selector);
        escrow.submitEvidence(id, EVIDENCE);
    }

    // ------------------------------------------------------------------ verification
    function test_Decision_UnauthorizedSignerRejected() public {
        uint256 id = _createSubmitted();
        uint64 dl = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sign(attackerKey, id, 1, EVIDENCE, RepairEscrow.Outcome.Verified, dl);
        vm.expectRevert(RepairEscrow.InvalidSignature.selector);
        escrow.recordDecision(id, 1, EVIDENCE, RepairEscrow.Outcome.Verified, REPORT, dl, sig);
    }

    function test_Decision_MalformedSignatureRejected() public {
        uint256 id = _createSubmitted();
        vm.expectRevert(RepairEscrow.InvalidSignature.selector);
        escrow.recordDecision(
            id, 1, EVIDENCE, RepairEscrow.Outcome.Verified, REPORT, uint64(block.timestamp + 1), hex"deadbeef"
        );
    }

    function test_Decision_TamperedOutcomeRejected() public {
        uint256 id = _createSubmitted();
        uint64 dl = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sign(verifierKey, id, 1, EVIDENCE, RepairEscrow.Outcome.Rejected, dl);
        vm.expectRevert(RepairEscrow.InvalidSignature.selector);
        escrow.recordDecision(id, 1, EVIDENCE, RepairEscrow.Outcome.Verified, REPORT, dl, sig);
    }

    function test_Decision_WrongEvidenceHashRejected() public {
        uint256 id = _createSubmitted();
        bytes32 other = keccak256("other");
        uint64 dl = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sign(verifierKey, id, 1, other, RepairEscrow.Outcome.Verified, dl);
        vm.expectRevert(RepairEscrow.EvidenceMismatch.selector);
        escrow.recordDecision(id, 1, other, RepairEscrow.Outcome.Verified, REPORT, dl, sig);
    }

    function test_Decision_SignatureForOtherProjectRejected() public {
        uint256 a = _createSubmitted();
        uint256 b = _createSubmitted();
        uint64 dl = uint64(block.timestamp + 1 hours);
        bytes memory sigA = _sign(verifierKey, a, 1, EVIDENCE, RepairEscrow.Outcome.Verified, dl);
        vm.expectRevert(RepairEscrow.InvalidSignature.selector);
        escrow.recordDecision(b, 1, EVIDENCE, RepairEscrow.Outcome.Verified, REPORT, dl, sigA);
    }

    function test_Decision_SignatureForOtherContractRejected() public {
        uint256 id = _createSubmitted();
        RepairEscrow other = new RepairEscrow(admin);
        uint64 dl = uint64(block.timestamp + 1 hours);
        bytes32 digest = other.decisionDigest(id, 1, EVIDENCE, RepairEscrow.Outcome.Verified, REPORT, dl);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(verifierKey, digest);
        vm.expectRevert(RepairEscrow.InvalidSignature.selector);
        escrow.recordDecision(id, 1, EVIDENCE, RepairEscrow.Outcome.Verified, REPORT, dl, abi.encodePacked(r, s, v));
    }

    function test_Decision_ExpiredSignatureRejected() public {
        uint256 id = _createSubmitted();
        uint64 dl = uint64(block.timestamp + 10);
        bytes memory sig = _sign(verifierKey, id, 1, EVIDENCE, RepairEscrow.Outcome.Verified, dl);
        vm.warp(block.timestamp + 11);
        vm.expectRevert(RepairEscrow.SignatureExpired.selector);
        escrow.recordDecision(id, 1, EVIDENCE, RepairEscrow.Outcome.Verified, REPORT, dl, sig);
    }

    function test_Decision_ReplayAfterResubmissionRejected() public {
        uint256 id = _createSubmitted();
        uint64 dl = uint64(block.timestamp + 1 days);
        // Verifier rejects round 1
        bytes memory rejectSig = _sign(verifierKey, id, 1, EVIDENCE, RepairEscrow.Outcome.Rejected, dl);
        escrow.recordDecision(id, 1, EVIDENCE, RepairEscrow.Outcome.Rejected, REPORT, dl, rejectSig);
        // Provider resubmits the same bundle hash → round 2
        vm.prank(provider);
        escrow.submitEvidence(id, EVIDENCE);
        // Replaying the round-1 decision must fail (round binding)
        vm.expectRevert(RepairEscrow.EvidenceMismatch.selector);
        escrow.recordDecision(id, 1, EVIDENCE, RepairEscrow.Outcome.Rejected, REPORT, dl, rejectSig);
        assertEq(uint8(_state(id)), uint8(RepairEscrow.State.Submitted));
    }

    function test_Decision_RevokedVerifierCannotDecide() public {
        uint256 id = _createSubmitted();
        vm.prank(admin);
        escrow.setVerifierApproval(verifier, false);
        uint64 dl = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sign(verifierKey, id, 1, EVIDENCE, RepairEscrow.Outcome.Verified, dl);
        vm.expectRevert(abi.encodeWithSelector(RepairEscrow.ParticipantNotApproved.selector, verifier));
        escrow.recordDecision(id, 1, EVIDENCE, RepairEscrow.Outcome.Verified, REPORT, dl, sig);
    }

    function test_Decision_NoneOutcomeRejected() public {
        uint256 id = _createSubmitted();
        uint64 dl = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sign(verifierKey, id, 1, EVIDENCE, RepairEscrow.Outcome.None, dl);
        vm.expectRevert(RepairEscrow.InvalidOutcome.selector);
        escrow.recordDecision(id, 1, EVIDENCE, RepairEscrow.Outcome.None, REPORT, dl, sig);
    }

    // ------------------------------------------------------------------ settlement safety
    function test_Rejected_CannotPay() public {
        uint256 id = _createSubmitted();
        _decide(id, RepairEscrow.Outcome.Rejected);
        vm.expectRevert(abi.encodeWithSelector(RepairEscrow.InvalidState.selector, RepairEscrow.State.Rejected));
        escrow.releasePayment(id);
    }

    function test_Inconclusive_CannotPay() public {
        uint256 id = _createSubmitted();
        _decide(id, RepairEscrow.Outcome.Inconclusive);
        vm.expectRevert(abi.encodeWithSelector(RepairEscrow.InvalidState.selector, RepairEscrow.State.Inconclusive));
        escrow.releasePayment(id);
    }

    function test_EvidenceRequested_ThenResubmit_ThenVerify() public {
        uint256 id = _createSubmitted();
        _decide(id, RepairEscrow.Outcome.AdditionalEvidenceRequired);
        assertEq(uint8(_state(id)), uint8(RepairEscrow.State.EvidenceRequested));
        vm.prank(provider);
        escrow.submitEvidence(id, keccak256("evidence-bundle-2"));
        assertEq(escrow.getProject(id).round, 2);
        _decide(id, RepairEscrow.Outcome.Verified);
        escrow.releasePayment(id);
        assertEq(uint8(_state(id)), uint8(RepairEscrow.State.Paid));
    }

    function test_DuplicatePayoutPrevented() public {
        uint256 id = _createSubmitted();
        _decide(id, RepairEscrow.Outcome.Verified);
        escrow.releasePayment(id);
        vm.expectRevert(abi.encodeWithSelector(RepairEscrow.InvalidState.selector, RepairEscrow.State.Paid));
        escrow.releasePayment(id);
    }

    function test_DecisionCannotBeRecordedTwice() public {
        uint256 id = _createSubmitted();
        RepairEscrow.Project memory p = escrow.getProject(id);
        uint64 dl = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sign(verifierKey, id, p.round, p.evidenceHash, RepairEscrow.Outcome.Verified, dl);
        escrow.recordDecision(id, p.round, p.evidenceHash, RepairEscrow.Outcome.Verified, REPORT, dl, sig);
        vm.expectRevert(abi.encodeWithSelector(RepairEscrow.InvalidState.selector, RepairEscrow.State.Verified));
        escrow.recordDecision(id, p.round, p.evidenceHash, RepairEscrow.Outcome.Verified, REPORT, dl, sig);
    }

    function test_AdminCannotTakeFunds() public {
        uint256 id = _createSubmitted();
        vm.startPrank(admin);
        vm.expectRevert(RepairEscrow.NotAuthorized.selector);
        escrow.cancel(id);
        vm.expectRevert(RepairEscrow.NotAuthorized.selector);
        escrow.refundExpired(id);
        vm.expectRevert(RepairEscrow.InvalidParameters.selector);
        escrow.withdraw();
        vm.stopPrank();
        assertEq(address(escrow).balance, AMOUNT);
    }

    // ------------------------------------------------------------------ disputes
    function test_Dispute_WithinWindowBlocksPayment_ThenFreshDecisionResolves() public {
        vm.prank(sponsor);
        uint256 id = escrow.createProject(provider, verifier, AMOUNT, TERMS, uint64(block.timestamp + 30 days), 2 days);
        vm.prank(sponsor);
        escrow.fund{value: AMOUNT}(id);
        vm.prank(provider);
        escrow.acceptAssignment(id);
        vm.prank(provider);
        escrow.submitEvidence(id, EVIDENCE);
        RepairEscrow.Project memory p = escrow.getProject(id);
        uint64 dl = uint64(block.timestamp + 10 days);
        bytes memory oldSig = _sign(verifierKey, id, p.round, EVIDENCE, RepairEscrow.Outcome.Verified, dl);
        escrow.recordDecision(id, p.round, EVIDENCE, RepairEscrow.Outcome.Verified, REPORT, dl, oldSig);

        vm.expectRevert(RepairEscrow.DisputeWindowOpen.selector);
        escrow.releasePayment(id);

        vm.prank(sponsor);
        escrow.dispute(id, keccak256("photos do not match site"));
        assertEq(uint8(_state(id)), uint8(RepairEscrow.State.Disputed));

        // The disputed decision cannot be replayed to resolve the dispute.
        vm.expectRevert(RepairEscrow.EvidenceMismatch.selector);
        escrow.recordDecision(id, p.round, EVIDENCE, RepairEscrow.Outcome.Verified, REPORT, dl, oldSig);

        // Verifier re-reviews and rejects under the new round.
        _decide(id, RepairEscrow.Outcome.Rejected);
        assertEq(uint8(_state(id)), uint8(RepairEscrow.State.Rejected));
    }

    function test_Dispute_AfterWindowClosedFails() public {
        uint256 id = _createSubmitted(); // disputeWindow = 0
        _decide(id, RepairEscrow.Outcome.Verified);
        vm.prank(sponsor);
        vm.expectRevert(RepairEscrow.DisputeWindowClosed.selector);
        escrow.dispute(id, bytes32(0));
    }

    function test_Dispute_OnlyParties() public {
        uint256 id = _createSubmitted();
        _decide(id, RepairEscrow.Outcome.Rejected);
        vm.prank(attacker);
        vm.expectRevert(RepairEscrow.NotAuthorized.selector);
        escrow.dispute(id, bytes32(0));
    }

    // ------------------------------------------------------------------ cancellation & expiry
    function test_Cancel_FundedRefundsSponsor() public {
        uint256 id = _createFunded();
        uint256 before = sponsor.balance;
        vm.prank(sponsor);
        escrow.cancel(id);
        assertEq(sponsor.balance - before, AMOUNT);
        assertEq(uint8(_state(id)), uint8(RepairEscrow.State.Cancelled));
    }

    function test_Cancel_NotAfterAssignment() public {
        uint256 id = _createFunded();
        vm.prank(provider);
        escrow.acceptAssignment(id);
        vm.prank(sponsor);
        vm.expectRevert(abi.encodeWithSelector(RepairEscrow.InvalidState.selector, RepairEscrow.State.Assigned));
        escrow.cancel(id);
    }

    function test_Cancelled_CannotProceed() public {
        uint256 id = _create();
        vm.prank(sponsor);
        escrow.cancel(id);
        vm.prank(sponsor);
        vm.expectRevert(abi.encodeWithSelector(RepairEscrow.InvalidState.selector, RepairEscrow.State.Cancelled));
        escrow.fund{value: AMOUNT}(id);
    }

    function test_Expiry_RefundsSponsorAndBlocksDecision() public {
        uint256 id = _createSubmitted();
        RepairEscrow.Project memory p = escrow.getProject(id);
        uint64 dl = uint64(p.expiresAt + 10 days);
        bytes memory sig = _sign(verifierKey, id, 1, EVIDENCE, RepairEscrow.Outcome.Verified, dl);
        vm.prank(sponsor);
        vm.expectRevert(RepairEscrow.NotExpired.selector);
        escrow.refundExpired(id);

        vm.warp(p.expiresAt + 1);
        vm.expectRevert(RepairEscrow.Expired.selector);
        escrow.recordDecision(id, 1, EVIDENCE, RepairEscrow.Outcome.Verified, REPORT, dl, sig);

        uint256 before = sponsor.balance;
        vm.prank(sponsor);
        escrow.refundExpired(id);
        assertEq(sponsor.balance - before, AMOUNT);
        vm.prank(sponsor);
        vm.expectRevert(abi.encodeWithSelector(RepairEscrow.InvalidState.selector, RepairEscrow.State.Refunded));
        escrow.refundExpired(id);
    }

    function test_Expiry_VerifiedProjectNotRefundable() public {
        uint256 id = _createSubmitted();
        _decide(id, RepairEscrow.Outcome.Verified);
        vm.warp(escrow.getProject(id).expiresAt + 1);
        vm.prank(sponsor);
        vm.expectRevert(abi.encodeWithSelector(RepairEscrow.InvalidState.selector, RepairEscrow.State.Verified));
        escrow.refundExpired(id);
        escrow.releasePayment(id); // still payable to the provider
        assertEq(uint8(_state(id)), uint8(RepairEscrow.State.Paid));
    }

    // ------------------------------------------------------------------ hostile receivers
    function test_Reentrancy_ProviderCannotDoubleCollect() public {
        ReentrantProvider evil = new ReentrantProvider(escrow);
        vm.prank(admin);
        escrow.setProviderApproval(address(evil), true);
        vm.prank(sponsor);
        uint256 id = escrow.createProject(address(evil), verifier, AMOUNT, TERMS, uint64(block.timestamp + 1 days), 0);
        vm.prank(sponsor);
        escrow.fund{value: AMOUNT}(id);
        evil.setProject(id);
        evil.accept();
        evil.submit(EVIDENCE);
        _decide(id, RepairEscrow.Outcome.Verified);
        escrow.releasePayment(id);
        assertTrue(evil.attempted());
        assertFalse(evil.reentrySucceeded());
        assertEq(address(evil).balance, AMOUNT);
        assertEq(address(escrow).balance, 0);
    }

    function test_RevertingProvider_FundsCreditedForWithdrawal() public {
        RevertingReceiver bad = new RevertingReceiver();
        vm.prank(admin);
        escrow.setProviderApproval(address(bad), true);
        vm.prank(sponsor);
        uint256 id = escrow.createProject(address(bad), verifier, AMOUNT, TERMS, uint64(block.timestamp + 1 days), 0);
        vm.prank(sponsor);
        escrow.fund{value: AMOUNT}(id);
        vm.prank(address(bad));
        escrow.acceptAssignment(id);
        vm.prank(address(bad));
        escrow.submitEvidence(id, EVIDENCE);
        _decide(id, RepairEscrow.Outcome.Verified);
        escrow.releasePayment(id);
        assertEq(uint8(_state(id)), uint8(RepairEscrow.State.Paid));
        assertEq(escrow.pendingWithdrawals(address(bad)), AMOUNT);
    }

    // ------------------------------------------------------------------ fuzz
    function testFuzz_OnlyVerifierKeyCanVerify(uint256 key) public {
        key = bound(key, 1, 115792089237316195423570985008687907852837564279074904382605163141518161494336);
        vm.assume(key != verifierKey);
        uint256 id = _createSubmitted();
        uint64 dl = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sign(key, id, 1, EVIDENCE, RepairEscrow.Outcome.Verified, dl);
        vm.expectRevert(RepairEscrow.InvalidSignature.selector);
        escrow.recordDecision(id, 1, EVIDENCE, RepairEscrow.Outcome.Verified, REPORT, dl, sig);
    }

    function testFuzz_FundingAmountMustMatch(uint96 amount, uint96 sent) public {
        vm.assume(amount > 0 && sent != amount);
        vm.deal(sponsor, uint256(sent) + 1);
        vm.prank(sponsor);
        uint256 id = escrow.createProject(provider, verifier, amount, TERMS, uint64(block.timestamp + 1 days), 0);
        vm.prank(sponsor);
        vm.expectRevert(RepairEscrow.WrongAmount.selector);
        escrow.fund{value: sent}(id);
    }
}
