// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title  PLUME Proof of Repair escrow
/// @notice Holds a sponsor's funding for an authorised methane repair project and releases it to the
///         repair provider only after the project's designated, independent verifier signs a VERIFIED
///         decision (EIP-712) bound to the exact evidence commitment under review.
/// @dev    Trust model: the chain cannot observe methane. It enforces *who* may move a project
///         between states and *what* evidence a decision refers to. Whether the repair worked is an
///         off-chain judgement by the verifier, recorded here as a signed, replay-proof attestation.
///         The owner (administrator) can only approve/revoke participants; it has no path to funds.
contract RepairEscrow is EIP712, ReentrancyGuard, Ownable2Step {
    enum State {
        None,
        Open, //               created, awaiting sponsor funding
        Funded, //             escrow holds funds, provider has not accepted
        Assigned, //           provider accepted the assignment
        Submitted, //          evidence committed, awaiting verifier decision
        Verified, //           verifier approved; payable after dispute window
        Rejected, //           verifier rejected; provider may resubmit or sponsor may dispute
        Inconclusive, //       verifier could not decide; resubmission possible
        EvidenceRequested, //  verifier asked for more evidence; resubmission possible
        Disputed, //           a party disputed; verifier must issue a fresh decision
        Paid, //               terminal: funds released to provider
        Cancelled, //          terminal: cancelled before work began (funds, if any, refunded)
        Refunded //            terminal: expired without verification, funds returned to sponsor
    }

    enum Outcome {
        None,
        Verified,
        Rejected,
        Inconclusive,
        AdditionalEvidenceRequired
    }

    struct Project {
        address sponsor;
        uint96 amount;
        address provider;
        uint64 expiresAt;
        uint32 round;
        State state;
        address verifier;
        uint64 verifiedAt;
        uint32 disputeWindow;
        bytes32 termsHash;
        bytes32 evidenceHash;
        bytes32 lastDecisionDigest;
    }

    bytes32 public constant DECISION_TYPEHASH = keccak256(
        "RepairDecision(uint256 projectId,uint32 round,bytes32 evidenceHash,uint8 outcome,bytes32 reportHash,uint64 deadline)"
    );
    uint32 public constant MAX_DISPUTE_WINDOW = 30 days;

    uint256 public projectCount;
    mapping(uint256 => Project) private _projects;
    mapping(address => bool) public approvedProvider;
    mapping(address => bool) public approvedVerifier;
    mapping(bytes32 => bool) public usedDecision;
    mapping(address => uint256) public pendingWithdrawals;

    event ParticipantApproval(bytes32 indexed role, address indexed account, bool approved);
    event ProjectCreated(
        uint256 indexed projectId,
        address indexed sponsor,
        address indexed provider,
        address verifier,
        uint256 amount,
        bytes32 termsHash,
        uint64 expiresAt,
        uint32 disputeWindow
    );
    event ProjectFunded(uint256 indexed projectId, address indexed sponsor, uint256 amount);
    event AssignmentAccepted(uint256 indexed projectId, address indexed provider);
    event EvidenceSubmitted(uint256 indexed projectId, uint32 indexed round, bytes32 evidenceHash);
    event DecisionRecorded(
        uint256 indexed projectId,
        uint32 indexed round,
        Outcome outcome,
        bytes32 evidenceHash,
        bytes32 reportHash,
        bytes32 digest,
        address submitter
    );
    event ProjectDisputed(uint256 indexed projectId, address indexed by, bytes32 reasonHash, uint32 newRound);
    event PaymentReleased(uint256 indexed projectId, address indexed provider, uint256 amount, bool pushed);
    event ProjectCancelled(uint256 indexed projectId, uint256 refunded);
    event ProjectRefunded(uint256 indexed projectId, address indexed sponsor, uint256 amount);
    event Withdrawal(address indexed account, uint256 amount);

    error NotAuthorized();
    error InvalidState(State current);
    error InvalidParameters();
    error ParticipantNotApproved(address account);
    error WrongAmount();
    error Expired();
    error NotExpired();
    error DisputeWindowOpen();
    error DisputeWindowClosed();
    error EvidenceMismatch();
    error SignatureExpired();
    error InvalidSignature();
    error DecisionAlreadyUsed();
    error InvalidOutcome();
    error TransferFailed();

    constructor(address admin) EIP712("PLUME Proof of Repair", "1") Ownable(admin) {}

    // ------------------------------------------------------------------ administration
    function setProviderApproval(address account, bool approved) external onlyOwner {
        approvedProvider[account] = approved;
        emit ParticipantApproval("PROVIDER", account, approved);
    }

    function setVerifierApproval(address account, bool approved) external onlyOwner {
        approvedVerifier[account] = approved;
        emit ParticipantApproval("VERIFIER", account, approved);
    }

    // ------------------------------------------------------------------ lifecycle
    function createProject(
        address provider,
        address verifier,
        uint256 amount,
        bytes32 termsHash,
        uint64 expiresAt,
        uint32 disputeWindow
    ) external returns (uint256 projectId) {
        if (provider == address(0) || verifier == address(0)) revert InvalidParameters();
        // Independence: no party may play two roles in the same project.
        if (provider == msg.sender || verifier == msg.sender || verifier == provider) revert InvalidParameters();
        if (amount == 0 || amount > type(uint96).max || termsHash == bytes32(0)) revert InvalidParameters();
        if (expiresAt <= block.timestamp || disputeWindow > MAX_DISPUTE_WINDOW) revert InvalidParameters();
        if (!approvedProvider[provider]) revert ParticipantNotApproved(provider);
        if (!approvedVerifier[verifier]) revert ParticipantNotApproved(verifier);

        projectId = ++projectCount;
        _projects[projectId] = Project({
            sponsor: msg.sender,
            amount: uint96(amount),
            provider: provider,
            expiresAt: expiresAt,
            round: 0,
            state: State.Open,
            verifier: verifier,
            verifiedAt: 0,
            disputeWindow: disputeWindow,
            termsHash: termsHash,
            evidenceHash: bytes32(0),
            lastDecisionDigest: bytes32(0)
        });
        emit ProjectCreated(projectId, msg.sender, provider, verifier, amount, termsHash, expiresAt, disputeWindow);
    }

    function fund(uint256 projectId) external payable {
        Project storage p = _project(projectId);
        if (msg.sender != p.sponsor) revert NotAuthorized();
        if (p.state != State.Open) revert InvalidState(p.state);
        if (block.timestamp > p.expiresAt) revert Expired();
        if (msg.value != p.amount) revert WrongAmount();
        p.state = State.Funded;
        emit ProjectFunded(projectId, msg.sender, msg.value);
    }

    function acceptAssignment(uint256 projectId) external {
        Project storage p = _project(projectId);
        if (msg.sender != p.provider) revert NotAuthorized();
        if (p.state != State.Funded) revert InvalidState(p.state);
        if (block.timestamp > p.expiresAt) revert Expired();
        if (!approvedProvider[msg.sender]) revert ParticipantNotApproved(msg.sender);
        p.state = State.Assigned;
        emit AssignmentAccepted(projectId, msg.sender);
    }

    /// @notice Commit to an evidence bundle (hash of an off-chain manifest). Starts a new review round.
    function submitEvidence(uint256 projectId, bytes32 evidenceHash) external {
        Project storage p = _project(projectId);
        if (msg.sender != p.provider) revert NotAuthorized();
        State s = p.state;
        if (s != State.Assigned && s != State.Rejected && s != State.Inconclusive && s != State.EvidenceRequested) {
            revert InvalidState(s);
        }
        if (block.timestamp > p.expiresAt) revert Expired();
        if (evidenceHash == bytes32(0)) revert InvalidParameters();
        p.round += 1;
        p.evidenceHash = evidenceHash;
        p.state = State.Submitted;
        emit EvidenceSubmitted(projectId, p.round, evidenceHash);
    }

    /// @notice Record the verifier's signed decision. Anyone may relay it; only the project's
    ///         verifier's signature over (project, round, evidence, outcome, report) is accepted.
    function recordDecision(
        uint256 projectId,
        uint32 round,
        bytes32 evidenceHash,
        Outcome outcome,
        bytes32 reportHash,
        uint64 deadline,
        bytes calldata signature
    ) external {
        Project storage p = _project(projectId);
        if (p.state != State.Submitted && p.state != State.Disputed) revert InvalidState(p.state);
        if (block.timestamp > p.expiresAt) revert Expired();
        if (block.timestamp > deadline) revert SignatureExpired();
        if (outcome == Outcome.None) revert InvalidOutcome();
        if (round != p.round || evidenceHash != p.evidenceHash) revert EvidenceMismatch();
        if (!approvedVerifier[p.verifier]) revert ParticipantNotApproved(p.verifier);

        bytes32 digest = decisionDigest(projectId, round, evidenceHash, outcome, reportHash, deadline);
        if (usedDecision[digest]) revert DecisionAlreadyUsed();
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || signer != p.verifier) revert InvalidSignature();

        usedDecision[digest] = true;
        p.lastDecisionDigest = digest;
        if (outcome == Outcome.Verified) {
            p.state = State.Verified;
            p.verifiedAt = uint64(block.timestamp);
        } else if (outcome == Outcome.Rejected) {
            p.state = State.Rejected;
        } else if (outcome == Outcome.Inconclusive) {
            p.state = State.Inconclusive;
        } else {
            p.state = State.EvidenceRequested;
        }
        emit DecisionRecorded(projectId, round, outcome, evidenceHash, reportHash, digest, msg.sender);
    }

    /// @notice Sponsor or provider can dispute a decision. A dispute bumps the round so that only a
    ///         fresh verifier decision (never a replay of the disputed one) can resolve it.
    function dispute(uint256 projectId, bytes32 reasonHash) external {
        Project storage p = _project(projectId);
        if (msg.sender != p.sponsor && msg.sender != p.provider) revert NotAuthorized();
        State s = p.state;
        if (s == State.Verified) {
            if (block.timestamp >= uint256(p.verifiedAt) + p.disputeWindow) revert DisputeWindowClosed();
        } else if (s != State.Rejected && s != State.Inconclusive) {
            revert InvalidState(s);
        }
        if (block.timestamp > p.expiresAt) revert Expired();
        p.round += 1;
        p.state = State.Disputed;
        p.verifiedAt = 0;
        emit ProjectDisputed(projectId, msg.sender, reasonHash, p.round);
    }

    /// @notice Release escrow to the provider once VERIFIED and the dispute window has elapsed.
    ///         Callable by anyone. Falls back to a pull-payment credit if the push transfer fails.
    function releasePayment(uint256 projectId) external nonReentrant {
        Project storage p = _project(projectId);
        if (p.state != State.Verified) revert InvalidState(p.state);
        if (block.timestamp < uint256(p.verifiedAt) + p.disputeWindow) revert DisputeWindowOpen();
        uint256 amount = p.amount;
        address provider = p.provider;
        p.state = State.Paid; // effects before interaction
        (bool ok,) = provider.call{value: amount, gas: 50_000}("");
        if (!ok) pendingWithdrawals[provider] += amount;
        emit PaymentReleased(projectId, provider, amount, ok);
    }

    /// @notice Sponsor may cancel before the provider has accepted. Funded projects are refunded.
    function cancel(uint256 projectId) external nonReentrant {
        Project storage p = _project(projectId);
        if (msg.sender != p.sponsor) revert NotAuthorized();
        State s = p.state;
        if (s != State.Open && s != State.Funded) revert InvalidState(s);
        uint256 refund = s == State.Funded ? p.amount : 0;
        p.state = State.Cancelled;
        if (refund > 0) _send(p.sponsor, refund);
        emit ProjectCancelled(projectId, refund);
    }

    /// @notice After expiry, an unverified project's escrow returns to the sponsor.
    function refundExpired(uint256 projectId) external nonReentrant {
        Project storage p = _project(projectId);
        if (msg.sender != p.sponsor) revert NotAuthorized();
        State s = p.state;
        if (
            s != State.Funded && s != State.Assigned && s != State.Submitted && s != State.Rejected
                && s != State.Inconclusive && s != State.EvidenceRequested && s != State.Disputed
        ) revert InvalidState(s);
        if (block.timestamp <= p.expiresAt) revert NotExpired();
        uint256 amount = p.amount;
        p.state = State.Refunded;
        _send(p.sponsor, amount);
        emit ProjectRefunded(projectId, p.sponsor, amount);
    }

    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert InvalidParameters();
        pendingWithdrawals[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawal(msg.sender, amount);
    }

    // ------------------------------------------------------------------ views
    function getProject(uint256 projectId) external view returns (Project memory) {
        return _projects[projectId];
    }

    function decisionDigest(
        uint256 projectId,
        uint32 round,
        bytes32 evidenceHash,
        Outcome outcome,
        bytes32 reportHash,
        uint64 deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(DECISION_TYPEHASH, projectId, round, evidenceHash, uint8(outcome), reportHash, deadline)
            )
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ------------------------------------------------------------------ internal
    function _project(uint256 projectId) private view returns (Project storage p) {
        p = _projects[projectId];
        if (p.state == State.None) revert InvalidParameters();
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount, gas: 50_000}("");
        if (!ok) pendingWithdrawals[to] += amount;
    }
}
