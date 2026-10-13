// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {RepairEscrow} from "../src/RepairEscrow.sol";

/// Deploys RepairEscrow and optionally approves an initial provider and verifier.
/// Env: DEPLOYMENT_NAME (default "local"), APPROVE_PROVIDERS / APPROVE_VERIFIERS (comma-separated addresses).
contract Deploy is Script {
    function run() external {
        string memory name = vm.envOr("DEPLOYMENT_NAME", string("local"));
        address[] memory empty = new address[](0);
        address[] memory providers = vm.envOr("APPROVE_PROVIDERS", ",", empty);
        address[] memory verifiers = vm.envOr("APPROVE_VERIFIERS", ",", empty);

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        RepairEscrow escrow = new RepairEscrow(deployer);
        for (uint256 i = 0; i < providers.length; i++) {
            escrow.setProviderApproval(providers[i], true);
        }
        for (uint256 i = 0; i < verifiers.length; i++) {
            escrow.setVerifierApproval(verifiers[i], true);
        }
        vm.stopBroadcast();

        string memory obj = "deployment";
        vm.serializeAddress(obj, "address", address(escrow));
        vm.serializeAddress(obj, "admin", deployer);
        vm.serializeUint(obj, "chainId", block.chainid);
        string memory json = vm.serializeUint(obj, "deployBlock", block.number);
        vm.writeJson(json, string.concat("./deployments/", name, ".json"));
        console2.log("RepairEscrow deployed", address(escrow), "chain", block.chainid);
    }
}
