export type Role = "observer" | "sponsor" | "provider" | "verifier" | "admin";

export interface User {
  id: string;
  display_name: string;
  organization: string;
  role: Role;
  wallet_address: string | null;
  is_demo: boolean;
}

export interface Meta {
  data: {
    mode: string;
    source_ref: string | null;
    source_sha256: string | null;
    ingested_at: string | null;
    observation_count: number;
    observed_from: string;
    observed_to: string;
    attribution: string;
    label: string;
  };
  repair: { label: string; simulation: boolean };
  chain: {
    connected: boolean;
    name: string;
    chain_id: number;
    contract?: string;
    explorer?: string | null;
    chain_time?: number | null;
    label: string;
    error?: string;
  };
  llm: { provider: string; model: string | null; fallback: string };
  demo_mode: boolean;
  featured_incidents: { code: string; role: string; why: string }[];
}

export interface ObsFeatureProps {
  id: string;
  t: string;
  ts: number;
  rate: number | null;
  unc: number | null;
  inst: string | null;
  sector: string;
  incident: string;
}

export interface ObsGeoJSON {
  type: "FeatureCollection";
  features: { type: "Feature"; geometry: { type: "Point"; coordinates: [number, number] }; properties: ObsFeatureProps }[];
}

export interface Observation {
  id: string;
  display_id: string;
  provider: string;
  external_id: string;
  gas: string;
  observed_at: string;
  longitude: number;
  latitude: number;
  emission_rate_kg_h: number | null;
  emission_uncertainty_kg_h: number | null;
  instrument: string | null;
  platform: string | null;
  sector: string | null;
  sector_label: string;
  quality: string | null;
  wind_speed_m_s: number | null;
  footprint_bounds: [number, number, number, number] | null;
  source_url: string;
  provider_source_name: string | null;
  validation_flags: string[];
  raw_sha256: string;
  ingested_at: string;
}

export interface Factor {
  name: string;
  weight: number;
  value: number | null;
  contribution: number;
  evidence: string;
}

export interface IncidentSummary {
  id: string;
  code: string;
  status: string;
  longitude: number;
  latitude: number;
  sector: string | null;
  sector_label: string;
  observation_count: number;
  detection_date_count: number;
  instrument_count: number;
  first_observed_at: string;
  last_observed_at: string;
  max_rate_kg_h: number | null;
  median_rate_kg_h: number | null;
  priority_score: number;
}

export interface ProviderSource {
  source_name: string;
  sector: string | null;
  plume_count: number;
  detection_date_count: number;
  observation_date_count: number;
  persistence: number;
  emission_auto_kg_h: number | null;
  timestamp_min: string;
  timestamp_max: string;
}

export interface IncidentDetail extends IncidentSummary {
  spatial_spread_m: number;
  priority_breakdown: { version: string; score: number; reference_time: string; factors: Factor[]; interpretation: string };
  grouping_method: string;
  grouping_params: { eps_m: number; min_samples: number; metric: string };
  provider_source_context: { primary: string | null; sources: Record<string, ProviderSource> };
  observations: Observation[];
  investigations: { id: string; created_at: string; report_kind: string; model_identifier: string; latency_ms: number }[];
  repair_projects: ProjectBrief[];
}

export interface EvidenceRef {
  id: string;
  kind: string;
  label: string;
  url: string | null;
}

export interface Report {
  schema_version: string;
  incident_id: string;
  incident_code: string;
  investigation_id: string;
  source_observation_ids: string[];
  summary: string;
  data_validation: { name: string; status: "pass" | "warn" | "fail"; detail: string }[];
  confirmed_observations: { statement: string; evidence_refs: string[] }[];
  possible_explanations: { statement: string; basis_refs: string[]; confidence: "low" | "medium" | "high" }[];
  observed_emission_rate: {
    median: number | null;
    maximum: number | null;
    minimum: number | null;
    unit: string;
    quantified_detections: number;
    total_detections: number;
    basis: string;
  };
  measurement_uncertainty: { median_relative_uncertainty: number | null; max_reported_uncertainty_kg_h: number | null; basis: string };
  potential_sector: { code: string | null; label: string };
  sector_confidence: string;
  sector_confidence_basis: string;
  possible_source_matches: { kind: string; identifier: string; description: string; evidence_refs: string[] }[];
  prioritization_score: number;
  prioritization_breakdown: IncidentDetail["priority_breakdown"];
  suggested_actions: { action: string; rationale: string; knowledge_refs: string[]; suggested_evidence: string[] }[];
  next_investigation_steps: string[];
  unresolved_questions: string[];
  limitations: string[];
  evidence_references: EvidenceRef[];
  grounding: { checked_fields: string[]; unknown_refs: string[]; unsupported_numbers: string[]; named_entity_flags: string[]; passed: boolean };
  generation: { kind: "llm" | "template"; model_identifier: string; generated_at: string; latency_ms: number; note: string };
}

export interface InvestigationOut {
  id: string;
  incident_id: string;
  created_at?: string;
  report_kind?: string;
  model_identifier?: string;
  latency_ms?: number;
  inputs_digest?: string;
  report: Report;
}

export interface ProjectBrief {
  id: string;
  code: string;
  title: string;
  status: string;
  funding_amount_wei: string;
  created_at: string;
  updated_at: string;
  incident_id: string;
  onchain_project_id: number | null;
  is_simulation: boolean;
  incident_code?: string;
  methodology?: string;
  sponsor_id?: string;
  provider_id?: string;
  verifier_id?: string;
}

export interface PolicyCheck {
  id: string;
  label: string;
  status: "pass" | "fail" | "warn" | "n/a";
  required: boolean;
  detail: string;
}

export interface EvidenceOut {
  id: string;
  round: number;
  submitted_by: string;
  content_hash: string;
  manifest: {
    schema: string;
    round: number;
    files: { name: string; sha256: string; size: number; media_type: string; stored_as: string }[];
    payload: EvidencePayload;
    [k: string]: unknown;
  };
  is_simulated: boolean;
  tx_hash: string | null;
  submitted_at: string;
}

export interface Measurement {
  rate_kg_h: number;
  uncertainty_kg_h: number;
  measured_at: string;
}

export interface EvidencePayload {
  is_simulated: boolean;
  site_authorization_ref: string;
  repair_record: {
    work_summary: string;
    components_repaired: string[];
    started_at: string;
    completed_at: string;
    performed_by: string;
  };
  documents: { doc_type: string; title: string; description: string; file_name: string | null }[];
  measurements: { method: string; pre_repair: Measurement; post_repair: Measurement[] } | null;
  notes: string;
}

export interface Impact {
  calculation_version: string;
  status: "quantified" | "not_quantified";
  reason: string;
  baseline_rate_kg_h: number | null;
  baseline_uncertainty_kg_h: number | null;
  post_rate_kg_h: number | null;
  post_uncertainty_kg_h: number | null;
  reduction_rate_kg_h: number | null;
  reduction_uncertainty_kg_h: number | null;
  supported_duration_h: number | null;
  duration_basis: string | null;
  ch4_avoided_kg: number | null;
  ch4_avoided_kg_low: number | null;
  ch4_avoided_kg_high: number | null;
  gwp_basis: string;
  gwp_value: number;
  gwp_reference: string;
  gwp_source_url: string;
  co2e_avoided_kg: number | null;
  co2e_avoided_kg_low: number | null;
  co2e_avoided_kg_high: number | null;
  assumptions: string[];
  is_simulated: boolean;
}

export interface VerificationOut {
  id: string;
  round: number;
  verifier_id: string;
  outcome: string;
  methodology: string;
  policy_checks: PolicyCheck[];
  notes: string;
  impact: Impact & { report?: Record<string, unknown>; report_hash?: string; typed_data?: Record<string, unknown> };
  eip712_digest: string;
  signature: string;
  tx_hash: string | null;
  decided_at: string;
}

export interface Project extends ProjectBrief {
  repair_scope: string;
  site_authorization: string;
  milestones: { name: string; description: string }[];
  evidence_policy: {
    methodology: string;
    label: string;
    description: string;
    required_documents: string[];
    requires_measurements: boolean;
    min_monitoring_days: number;
  };
  expires_at: string;
  dispute_window_s: number;
  terms: Record<string, unknown>;
  terms_hash: string;
  chain_id: number | null;
  contract_address: string | null;
  evidence_round: number;
  funded_at_chain: string | null;
  last_reconciled_at: string | null;
  investigation_id: string | null;
  incident: IncidentSummary | null;
  participants: { sponsor: User | null; provider: User | null; verifier: User | null };
  evidence: EvidenceOut[];
  verifications: VerificationOut[];
  receipt_id: string | null;
  onchain: {
    state?: string;
    round?: number;
    amount_wei?: string;
    evidence_hash?: string;
    terms_hash?: string;
    last_decision_digest?: string;
    expires_at?: number;
    verified_at?: number;
    dispute_window?: number;
    escrow_balance_wei?: string;
    chain_time?: number;
    error?: string;
  } | null;
  allowed_actions: string[];
}

export interface History {
  audit: { id: number; actor: string | null; action: string; previous_state: string | null; new_state: string | null; details: Record<string, unknown>; tx_hash: string | null; at: string }[];
  chain_events: { event: string; args: Record<string, unknown>; tx_hash: string; block: number; log_index: number; block_time: string | null }[];
  explorer: string | null;
}

export interface VerificationContext {
  checks: PolicyCheck[];
  blocking: string[];
  impact_preview: Impact;
  evidence: EvidenceOut;
  chain_time: string;
  incident: IncidentSummary | null;
  observations: { display_id: string; observed_at: string; rate: number | null; unc: number | null; instrument: string | null; url: string }[];
  post_funding_observations: string[];
  investigation_summary: string | null;
  methodology: { label: string; description: string; required_documents: string[]; requires_measurements: boolean };
  satellite_note: string;
}

export interface Receipt {
  id: string;
  created_at: string;
  payload_sha256: string;
  project_code: string;
  project_id: string;
  history: History;
  investigation: { id: string; summary: string; kind: string; model: string } | null;
  explorer: string | null;
  payload: {
    schema: string;
    label: string;
    incident: {
      id: string;
      code: string;
      latitude: number;
      longitude: number;
      sector: string | null;
      observation_sources: { id: string; provider: string; observed_at: string; url: string; emission_rate_kg_h: number | null; uncertainty_kg_h: number | null }[];
    };
    repair_project: { id: string; code: string; title: string; scope: string; terms_hash: string; is_simulation: boolean };
    verification: { result: string; methodology: string; round: number; eip712_digest: string; decision_tx: string; policy_checks: PolicyCheck[]; decided_at: string };
    evidence: { hash: string; round: number; is_simulated: boolean; submission_tx: string };
    impact: Impact;
    chain: { network: string; chain_id: number; contract: string; onchain_project_id: number; settlement_tx: string; settlement_block: number; settled_at_chain_time: string };
  };
}
