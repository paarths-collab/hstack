/**
 * Agent Recipes' small, dependency-free safety core.
 *
 * This module deliberately knows nothing about credentials, SSH, APIs, or live
 * deployment. It turns an allowlisted recipe + connector selection into the
 * existing secret-free hstack blueprint contract. Specialist official skills
 * remain the only code allowed to collect credentials or mutate Hermes.
 */

const SUPPORTED_STATUSES = new Set([
  "labs",
  "contract-tested",
  "self-tested",
  "pilot-tested",
  "proven",
]);

const SUPPORTED_CADENCES = {
  manual: null,
  weekdays: "Weekdays, chosen time",
  weekly: "Weekly, chosen time",
};

const SUPPORTED_INSTALLATIONS = new Set(["existing_agent", "deploy_if_missing"]);

export class RecipeCompilerError extends Error {
  constructor(message) {
    super(message);
    this.name = "RecipeCompilerError";
  }
}

function fail(message) {
  throw new RecipeCompilerError(message);
}

function requiredObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${label} must be a non-empty string.`);
  }
  return value;
}

function uniqueStringList(value, label) {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array.`);
  }
  const ids = [];
  const seen = new Set();
  for (const item of value) {
    const id = requiredString(item, `${label} item`);
    if (seen.has(id)) {
      fail(`${label} cannot include '${id}' more than once.`);
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function normaliseConnectorDefinition(connector) {
  requiredObject(connector, "connector");
  const capabilities = connector.capabilities ?? (connector.role ? [connector.role] : undefined);
  const suppliedPermission = connector.permission && typeof connector.permission === "object"
    ? connector.permission
    : {};
  const suppliedSetup = connector.setup && typeof connector.setup === "object"
    ? connector.setup
    : {};
  const customerSetup = connector.customer_setup && typeof connector.customer_setup === "object"
    ? connector.customer_setup
    : {};
  const role = connector.role ?? capabilities?.[0];
  const defaultScope = role === "source"
    ? "Read-only access to only the selected data."
    : "Private, allowlisted delivery access."
  return {
    ...connector,
    capabilities,
    skill: connector.skill ?? connector.hstack_skill,
    permission: {
      ...suppliedPermission,
      default: suppliedPermission.default ?? connector.access,
    },
    setup: {
      ...suppliedSetup,
      customer_action: suppliedSetup.customer_action ?? customerSetup.summary,
      credential_label: suppliedSetup.credential_label
        ?? customerSetup.credential_label
        ?? "Requested only during service setup",
      recommended_scope: suppliedSetup.recommended_scope
        ?? customerSetup.recommended_scope
        ?? defaultScope,
    },
  };
}

function connectorMap(connectors) {
  if (!Array.isArray(connectors)) {
    fail("connectors must be an array.");
  }
  const byId = new Map();
  for (const rawConnector of connectors) {
    const connector = normaliseConnectorDefinition(rawConnector);
    const id = requiredString(connector.id, "connector.id");
    if (byId.has(id)) {
      fail(`connector id '${id}' is duplicated.`);
    }
    byId.set(id, connector);
  }
  return byId;
}

function recipeConnectorIds(recipe, capability) {
  const ids = requiredObject(recipe.connector_ids, "recipe.connector_ids")[capability];
  return uniqueStringList(ids, `recipe.connector_ids.${capability}`);
}

function capabilityMinimum(recipe, capability) {
  const details = requiredObject(recipe.capabilities, "recipe.capabilities")[capability];
  requiredObject(details, `recipe.capabilities.${capability}`);
  if (!Number.isInteger(details.min) || details.min < 0) {
    fail(`recipe.capabilities.${capability}.min must be a non-negative integer.`);
  }
  return details.min;
}

function connectorHasCapability(connector, capability) {
  return Array.isArray(connector.capabilities) && connector.capabilities.includes(capability);
}

function connectorPermission(connector) {
  const permission = requiredObject(connector.permission, `connector '${connector.id}' permission`);
  return requiredString(permission.default, `connector '${connector.id}' permission.default`);
}

function orderedSelection(selection, allowedIds, byId, capability, label) {
  const selectedIds = uniqueStringList(selection, label);
  for (const id of selectedIds) {
    if (!allowedIds.includes(id)) {
      fail(`'${id}' is not supported by this recipe as a ${capability}.`);
    }
    const connector = byId.get(id);
    if (!connector) {
      fail(`Connector '${id}' is missing from the registry.`);
    }
    if (!connectorHasCapability(connector, capability)) {
      fail(`Connector '${id}' is not registered as a ${capability}.`);
    }
  }
  // The recipe order, rather than click order, keeps generated plans deterministic.
  return allowedIds.filter((id) => selectedIds.includes(id)).map((id) => byId.get(id));
}

function normaliseSelection(selection = {}) {
  requiredObject(selection, "selection");
  const cadence = selection.cadence ?? "manual";
  if (!Object.hasOwn(SUPPORTED_CADENCES, cadence)) {
    fail("cadence must be manual, weekdays, or weekly.");
  }
  const installation = selection.installation ?? "existing_agent";
  if (!SUPPORTED_INSTALLATIONS.has(installation)) {
    fail("installation must be existing_agent or deploy_if_missing.");
  }
  return {
    sourceIds: selection.sourceIds ?? [],
    deliveryIds: selection.deliveryIds ?? [],
    cadence,
    installation,
  };
}

function normaliseStatus(status) {
  if (typeof status === "string") {
    return status.replaceAll("_", "-");
  }
  if (status && typeof status === "object" && typeof status.level === "string") {
    return status.level.replaceAll("_", "-");
  }
  fail("recipe.status must be a status string or an object with a level.");
}

function normaliseSourceBlueprint(value) {
  if (value === "saas-founder" || value === "blueprints/saas-founder.hstack-blueprint.json") {
    return "saas-founder";
  }
  fail("Founder Brief must map to the saas-founder source blueprint.");
}

/**
 * The first catalog shipped narrative metadata before the core package existed.
 * Normalize that public shape at one boundary so the compiler itself still has
 * one strict, small contract. New recipes should prefer the canonical keys.
 */
function normaliseRecipeDefinition(recipe) {
  requiredObject(recipe, "recipe");
  const legacyRules = recipe.connector_rules ?? {};
  const legacySources = legacyRules.sources ?? {};
  const legacyDelivery = legacyRules.deliveries ?? {};
  const runtime = recipe.runtime ?? {
    default: recipe.deployment?.runtime,
    supported: recipe.deployment?.runtime ? [recipe.deployment.runtime] : [],
  };
  const capabilities = recipe.capabilities ?? {
    sources: { min: legacySources.minimum_for_live_deployment },
    delivery: { min: legacyDelivery.minimum_for_live_deployment },
    preview_allowed: recipe.deployment?.preview_available,
  };
  const connectorIds = recipe.connector_ids ?? {
    sources: legacySources.ids,
    delivery: legacyDelivery.ids,
  };
  return {
    ...recipe,
    status: normaliseStatus(recipe.status),
    runtime,
    source_blueprint: normaliseSourceBlueprint(
      recipe.source_blueprint ?? recipe.deployment?.source_blueprint,
    ),
    capabilities,
    connector_ids: connectorIds,
  };
}

/**
 * Check the recipe registry before it is shown or compiled. This makes it
 * impossible for a browser selection to smuggle in arbitrary skill names.
 */
export function validateRecipeCatalog({ recipe, connectors }) {
  const canonicalRecipe = normaliseRecipeDefinition(recipe);
  if (canonicalRecipe.schema_version !== 1) {
    fail("recipe.schema_version must equal 1.");
  }
  if (canonicalRecipe.id !== "founder-brief") {
    fail("This compiler currently supports only the founder-brief recipe.");
  }
  if (!SUPPORTED_STATUSES.has(canonicalRecipe.status)) {
    fail(`recipe.status '${canonicalRecipe.status}' is not recognised.`);
  }
  if (canonicalRecipe.runtime?.default !== "hermes" || !canonicalRecipe.runtime?.supported?.includes("hermes")) {
    fail("Founder Brief must declare Hermes as a supported runtime.");
  }

  const byId = connectorMap(connectors);
  for (const capability of ["sources", "delivery"]) {
    const connectorCapability = capability === "sources" ? "source" : "delivery";
    capabilityMinimum(canonicalRecipe, capability);
    for (const id of recipeConnectorIds(canonicalRecipe, capability)) {
      const connector = byId.get(id);
      if (!connector) {
        fail(`Recipe references missing connector '${id}'.`);
      }
      if (!connectorHasCapability(connector, connectorCapability)) {
        fail(`Recipe connector '${id}' is missing '${connectorCapability}' capability.`);
      }
      requiredString(connector.skill, `connector '${id}' skill`);
      const permission = connectorPermission(connector);
      if (connectorCapability === "source" && permission !== "read_only") {
        fail(`Recipe source '${id}' must default to read_only access.`);
      }
      if (connectorCapability === "delivery" && connector.approval_required !== true) {
        fail(`Recipe delivery '${id}' must require approval before sending externally.`);
      }
    }
  }

  if (canonicalRecipe.capabilities.preview_allowed !== true) {
    fail("Founder Brief must explicitly allow a no-credential preview.");
  }
  return canonicalRecipe;
}

/**
 * Return the gentle, user-facing readiness state. A preview is always allowed;
 * only an actual deployment needs capability coverage.
 */
export function getReadiness({ recipe, connectors, selection = {} }) {
  const canonicalRecipe = validateRecipeCatalog({ recipe, connectors });
  const byId = connectorMap(connectors);
  const normalised = normaliseSelection(selection);
  const sources = orderedSelection(
    normalised.sourceIds,
    recipeConnectorIds(canonicalRecipe, "sources"),
    byId,
    "source",
    "selection.sourceIds",
  );
  const delivery = orderedSelection(
    normalised.deliveryIds,
    recipeConnectorIds(canonicalRecipe, "delivery"),
    byId,
    "delivery",
    "selection.deliveryIds",
  );

  const errors = [];
  if (normalised.cadence !== "manual" && delivery.length === 0) {
    errors.push("Choose a delivery destination before scheduling a brief.");
  }
  if (normalised.installation === "deploy_if_missing" && delivery.length === 0) {
    errors.push("A new Hermes deployment needs a delivery destination.");
  }

  const missing = [];
  if (sources.length < capabilityMinimum(canonicalRecipe, "sources")) {
    missing.push("Choose at least one information source for a live brief.");
  }
  if (delivery.length < capabilityMinimum(canonicalRecipe, "delivery")) {
    missing.push("Choose a destination for a live brief.");
  }
  const deployable = errors.length === 0 && missing.length === 0;
  const messages = deployable
    ? ["Ready to create a safe, read-only deployment plan."]
    : ["Preview mode is on. No credentials are requested.", ...missing, ...errors];

  return {
    recipe: canonicalRecipe,
    ...normalised,
    sources,
    delivery,
    errors,
    missing,
    deployable,
    state: deployable ? "ready" : "preview",
    messages,
  };
}

function unique(values) {
  return [...new Set(values)];
}

function deriveSkills({ installation, delivery, sources, automations }) {
  const skills = [];
  if (installation === "deploy_if_missing") {
    skills.push("hermes-deploy");
    // /hermes-deploy owns the first channel on a fresh install.
    skills.push(...delivery.slice(1).map((connector) => connector.skill));
  } else {
    skills.push(...delivery.map((connector) => connector.skill));
  }
  skills.push(...sources.map((connector) => connector.skill));
  if (delivery.length > 0) {
    skills.push("hermes-home");
  }
  if (automations.length > 0) {
    skills.push("hermes-cron");
  }
  return unique(skills);
}

function credentialRequirement(connector) {
  const setup = requiredObject(connector.setup, `connector '${connector.id}' setup`);
  return {
    service: requiredString(connector.name, `connector '${connector.id}' name`),
    credential: requiredString(setup.credential_label, `connector '${connector.id}' credential label`),
    recommended_scope: requiredString(setup.recommended_scope, `connector '${connector.id}' recommended scope`),
  };
}

function customerAction(connector) {
  const setup = requiredObject(connector.setup, `connector '${connector.id}' setup`);
  return {
    connector: connector.name,
    action: requiredString(setup.customer_action, `connector '${connector.id}' customer action`),
  };
}

function automationFor(cadence) {
  if (cadence === "manual") {
    return [];
  }
  return [{
    id: "morning-briefing",
    enabled: true,
    cadence: SUPPORTED_CADENCES[cadence],
  }];
}

function plainNames(connectors) {
  return connectors.map((connector) => connector.name);
}

/**
 * Build a deployable Founder Brief artifact from trusted catalog entries only.
 * A non-deployable selection returns a preview, never a fake or incomplete plan.
 */
export function compileFounderBrief({ recipe, connectors, selection = {} }) {
  const readiness = getReadiness({ recipe, connectors, selection });
  if (readiness.errors.length > 0) {
    fail(readiness.errors.join(" "));
  }
  if (!readiness.deployable) {
    return {
      state: "preview",
      deployable: false,
      messages: readiness.messages,
      summary: {
        sources: plainNames(readiness.sources),
        delivery: plainNames(readiness.delivery),
        cadence: readiness.cadence,
        permissions: "Read-only by default. External and destructive actions always need approval.",
      },
      customerActions: [],
      verification: [],
      rollback: [],
    };
  }

  const automations = automationFor(readiness.cadence);
  const selectedConnectors = [...readiness.delivery, ...readiness.sources];
  const blueprint = {
    schema_version: 1,
    name: "founder-brief",
    description: "A read-only founder operating brief from the sources you selected.",
    source_blueprints: [readiness.recipe.source_blueprint],
    runtime: {
      agent: "hermes",
      installation: readiness.installation,
    },
    delivery: {
      mode: readiness.delivery.length > 0 ? "platforms" : "terminal",
      channels: readiness.delivery.map((connector) => connector.id),
    },
    integrations: readiness.sources.map((connector) => ({
      id: connector.id,
      skill: connector.skill,
      access: connectorPermission(connector),
    })),
    automations,
    behaviors: {
      long_term_memory: false,
      automatic_backups: false,
    },
    policies: {
      external_messages: "approval_required",
      destructive_actions: "approval_required",
      safe_operations: "approval_required",
    },
    credential_requirements: selectedConnectors.map(credentialRequirement),
    resolved_skills: deriveSkills({
      installation: readiness.installation,
      delivery: readiness.delivery,
      sources: readiness.sources,
      automations,
    }),
  };

  const selectedSourceNames = plainNames(readiness.sources).join(", ");
  const selectedDeliveryNames = plainNames(readiness.delivery).join(", ");
  return {
    state: "ready",
    deployable: true,
    fileName: "founder-brief.hstack-blueprint.json",
    blueprint,
    messages: ["Your reviewed deployment plan is ready. It contains no credentials."],
    summary: {
      sources: plainNames(readiness.sources),
      delivery: plainNames(readiness.delivery),
      cadence: readiness.cadence,
      permissions: "Read-only by default. External and destructive actions always need approval.",
      runtime: "Hermes",
    },
    customerActions: selectedConnectors.map(customerAction),
    verification: [
      "Validate the downloaded plan before anything changes.",
      `Confirm that ${selectedDeliveryNames} receives the first approved test message.`,
      `Confirm that ${selectedSourceNames} is connected with the reviewed read-only scope.`,
      ...(automations.length > 0 ? ["Review the scheduled brief before it sends externally."] : []),
    ],
    rollback: [
      "If one setup step fails, stop there; do not remove earlier working connections.",
      "Let the official skill that made the failed change perform its scoped rollback.",
      "Remove only a newly-created scheduled brief after review; never delete the whole agent configuration.",
    ],
    handoffPrompt: [
      "I have reviewed a secret-free Agent Recipes Founder Brief plan.",
      "Please use the installed official blueprint-install skill to validate the downloaded plan before changing my Hermes agent.",
      "Keep every selected source read-only, request credentials only in the service's own setup step, and ask for approval before external messages or destructive actions.",
      "If a selected connection fails, stop and use that official skill's scoped rollback; do not remove earlier working connections.",
    ].join("\n\n"),
  };
}

export function stringifyBlueprint(result) {
  if (!result?.deployable || !result.blueprint) {
    fail("Only a ready recipe can be exported as a deployment plan.");
  }
  return `${JSON.stringify(result.blueprint, null, 2)}\n`;
}
