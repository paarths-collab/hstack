import {
  compileFounderBrief,
  getReadiness,
} from "../../packages/recipe-core/index.js";

const registryUrl = new URL("../../recipes/registry.json", import.meta.url);

function createFallbackSource({ id, name, shortLabel, description, mark, skill }) {
  return {
    id,
    name,
    kind: "source",
    category: "source",
    capabilities: ["source"],
    shortLabel,
    description,
    mark,
    skill,
    permission: { default: "read_only" },
    setup: {
      customer_action: `Authorize read-only ${name} access in your own agent setup.`,
      credential_label: `${name} connection`,
      recommended_scope: "Read-only access to only the selected data.",
    },
  };
}

function createFallbackDelivery({ id, name, shortLabel, description, mark, skill }) {
  return {
    id,
    name,
    kind: "delivery",
    category: "delivery",
    capabilities: ["delivery"],
    shortLabel,
    description,
    mark,
    skill,
    permission: { default: "approval_required" },
    approval_required: true,
    setup: {
      customer_action: `Approve ${name} as a private destination in your own agent setup.`,
      credential_label: `${name} connection`,
      recommended_scope: "Private, allowlisted delivery access.",
    },
  };
}

const fallbackRegistry = {
  recipes: [
    {
      schema_version: 1,
      id: "founder-brief",
      name: "Founder Brief",
      status: "contract-tested",
      outcome: "A simple read-only summary of the updates that matter to you.",
      deployment: {
        runtime: "hermes",
        source_blueprint: "blueprints/saas-founder.hstack-blueprint.json",
        preview_available: true,
      },
      connector_rules: {
        sources: {
          ids: ["github", "stripe", "posthog", "sentry", "notion", "linear"],
          minimum_for_live_deployment: 1,
        },
        deliveries: {
          ids: ["telegram", "slack", "discord"],
          minimum_for_live_deployment: 1,
        },
      },
    },
    { id: "devops-oncall", name: "DevOps On-Call", status: "labs" },
    { id: "chief-of-staff", name: "Chief of Staff", status: "labs" },
    { id: "research-scout", name: "Research Scout", status: "labs" },
    { id: "customer-pulse", name: "Customer Pulse", status: "labs" },
    { id: "sales-copilot", name: "Sales Copilot", status: "labs" },
    { id: "content-planner", name: "Content Planner", status: "labs" },
    { id: "startup-operator", name: "Startup Operator", status: "labs" },
  ],
  connectors: [
    createFallbackSource({
      id: "github",
      name: "GitHub",
      shortLabel: "Code activity",
      description: "Pull requests and project updates",
      mark: "GH",
      skill: "integration-github",
    }),
    createFallbackSource({
      id: "stripe",
      name: "Stripe",
      shortLabel: "Revenue signals",
      description: "Payments and subscription trends",
      mark: "ST",
      skill: "integration-stripe",
    }),
    createFallbackSource({
      id: "sentry",
      name: "Sentry",
      shortLabel: "Product health",
      description: "Errors worth noticing",
      mark: "SE",
      skill: "integration-sentry",
    }),
    createFallbackSource({
      id: "notion",
      name: "Notion",
      shortLabel: "Team context",
      description: "Notes and project context",
      mark: "NO",
      skill: "integration-notion",
    }),
    createFallbackSource({
      id: "posthog",
      name: "PostHog",
      shortLabel: "Product usage",
      description: "Product activity and trends",
      mark: "PH",
      skill: "integration-posthog",
    }),
    createFallbackSource({
      id: "linear",
      name: "Linear",
      shortLabel: "Product work",
      description: "Issues and project movement",
      mark: "LI",
      skill: "integration-linear",
    }),
    createFallbackDelivery({
      id: "telegram",
      name: "Telegram",
      shortLabel: "Send a message",
      description: "A brief in a private chat",
      mark: "TG",
      skill: "platform-telegram",
    }),
    createFallbackDelivery({
      id: "slack",
      name: "Slack",
      shortLabel: "Send a message",
      description: "A brief in your workspace",
      mark: "SL",
      skill: "platform-slack",
    }),
    createFallbackDelivery({
      id: "discord",
      name: "Discord",
      shortLabel: "Send a message",
      description: "A brief in your server",
      mark: "DC",
      skill: "platform-discord",
    }),
  ],
};

const dom = {
  sourceOptions: document.querySelector("#source-options"),
  deliveryOptions: document.querySelector("#delivery-options"),
  cadenceFieldset: document.querySelector("#cadence-fieldset"),
  cadence: document.querySelector("#cadence"),
  cadenceHelp: document.querySelector("#cadence-help"),
  installation: document.querySelectorAll('input[name="installation"]'),
  readinessBadge: document.querySelector("#readiness-badge"),
  previewButton: document.querySelector("#preview-button"),
  downloadButton: document.querySelector("#download-button"),
  copyButton: document.querySelector("#copy-button"),
  deployHelp: document.querySelector("#deploy-help"),
  planTitle: document.querySelector("#plan-title"),
  planState: document.querySelector("#plan-state"),
  planOverview: document.querySelector("#plan-overview"),
  reviewList: document.querySelector("#review-list"),
  verificationList: document.querySelector("#verification-list"),
  rollbackList: document.querySelector("#rollback-list"),
  technicalOutput: document.querySelector("#technical-output"),
  recipeStatuses: document.querySelector("#recipe-statuses"),
  toast: document.querySelector("#toast"),
};

const appState = {
  registry: fallbackRegistry,
  recipe: fallbackRegistry.recipes[0],
  selection: {
    sourceIds: [],
    deliveryIds: [],
    cadence: "manual",
    installation: "existing_agent",
  },
  readiness: null,
  plan: null,
  toastTimer: null,
};

function arrayOfStrings(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string" && item.trim());
  }

  if (typeof value === "string" && value.trim()) {
    return [value];
  }

  return [];
}

function normaliseConnector(rawConnector) {
  const supports = arrayOfStrings(
    rawConnector?.supportedRecipes
    || rawConnector?.supported_recipes
    || rawConnector?.recipes
    || rawConnector?.usable_with,
  );
  const capabilities = arrayOfStrings(rawConnector?.capabilities);
  const category = String(rawConnector?.category || rawConnector?.kind || rawConnector?.role || "").toLowerCase();
  const id = String(rawConnector?.id || "").trim();
  const isDelivery = category === "delivery"
    || category === "destination"
    || category === "channel"
    || capabilities.includes("delivery");

  return {
    ...rawConnector,
    id,
    name: String(rawConnector?.name || id),
    kind: isDelivery ? "delivery" : "source",
    shortLabel: String(rawConnector?.shortLabel || rawConnector?.summary || "Optional integration"),
    description: String(
      rawConnector?.description
      || rawConnector?.customerAction
      || rawConnector?.customer_setup?.summary
      || "Connect this only when you are ready.",
    ),
    mark: String(rawConnector?.mark || rawConnector?.name || id)
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 2)
      .toUpperCase(),
    supportedRecipes: supports,
  };
}

function normaliseRegistry(rawRegistry) {
  const rawRecipes = Array.isArray(rawRegistry) ? rawRegistry : rawRegistry?.recipes;
  const rawConnectors = Array.isArray(rawRegistry?.connectors)
    ? rawRegistry.connectors
    : Array.isArray(rawRegistry?.integrations)
      ? rawRegistry.integrations
      : [];

  const recipes = Array.isArray(rawRecipes) && rawRecipes.length > 0 ? rawRecipes : fallbackRegistry.recipes;
  const connectors = rawConnectors.length > 0 ? rawConnectors.map(normaliseConnector).filter((connector) => connector.id) : fallbackRegistry.connectors;

  return { recipes, connectors };
}

function flattenRegistryConnectors(connectors) {
  if (Array.isArray(connectors)) {
    return connectors;
  }
  if (!connectors || typeof connectors !== "object") {
    return [];
  }
  return Object.values(connectors).flatMap((group) => Array.isArray(group) ? group : []);
}

async function loadRegistryRecord(entry) {
  if (!entry || typeof entry !== "object" || !entry.path) {
    return entry;
  }
  const response = await fetch(new URL(entry.path, registryUrl), {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Registry record '${entry.id || entry.path}' returned ${response.status}`);
  }
  return response.json();
}

async function hydrateRegistry(rawRegistry) {
  if (!rawRegistry || typeof rawRegistry !== "object") {
    return rawRegistry;
  }
  const recipeEntries = Array.isArray(rawRegistry.recipes) ? rawRegistry.recipes : [];
  const connectorEntries = flattenRegistryConnectors(rawRegistry.connectors);
  const [recipes, connectors] = await Promise.all([
    Promise.all(recipeEntries.map(loadRegistryRecord)),
    Promise.all(connectorEntries.map(loadRegistryRecord)),
  ]);
  return { recipes, connectors };
}

async function loadRegistry() {
  try {
    const response = await fetch(registryUrl, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`Recipe registry returned ${response.status}`);
    }

    return normaliseRegistry(await hydrateRegistry(await response.json()));
  } catch (error) {
    console.info("Using the built-in recipe display while the registry is unavailable.", error);
    showToast("Using the built-in Founder Brief preview while the recipe library loads.");
    return fallbackRegistry;
  }
}

function getConnectorsForRecipe(kind) {
  return appState.registry.connectors.filter((connector) => {
    const supportedRecipes = connector.supportedRecipes || [];
    return connector.kind === kind && (supportedRecipes.length === 0 || supportedRecipes.includes(appState.recipe.id));
  });
}

function makeTile(connector, selectedIds) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "choice-tile";
  button.dataset.connectorId = connector.id;
  button.setAttribute("aria-pressed", String(selectedIds.includes(connector.id)));
  button.setAttribute("aria-label", `${selectedIds.includes(connector.id) ? "Remove" : "Choose"} ${connector.name}`);

  const mark = document.createElement("span");
  mark.className = "tile-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = connector.mark;

  const copy = document.createElement("span");
  copy.className = "tile-copy";
  const title = document.createElement("strong");
  title.textContent = connector.name;
  const detail = document.createElement("small");
  detail.textContent = connector.description || connector.shortLabel;
  copy.append(title, detail);
  button.append(mark, copy);

  button.addEventListener("click", () => toggleConnector(connector));
  return button;
}

function renderChoices() {
  const sources = getConnectorsForRecipe("source");
  const deliveries = getConnectorsForRecipe("delivery");
  dom.sourceOptions.replaceChildren(...sources.map((connector) => makeTile(connector, appState.selection.sourceIds)));
  dom.deliveryOptions.replaceChildren(...deliveries.map((connector) => makeTile(connector, appState.selection.deliveryIds)));
}

function renderRecipeStatuses() {
  const otherRecipes = appState.registry.recipes.filter((recipe) => recipe.id !== appState.recipe.id);
  const fragment = document.createDocumentFragment();

  otherRecipes.forEach((recipe) => {
    const item = document.createElement("article");
    item.className = "recipe-status";
    const name = document.createElement("strong");
    name.textContent = recipe.name || recipe.id;
    const status = document.createElement("span");
    status.textContent = formatStatus(recipe.status || "labs");
    item.append(name, status);
    fragment.append(item);
  });

  if (!otherRecipes.length) {
    const item = document.createElement("p");
    item.textContent = "New recipes will appear only when they have a clear test status.";
    fragment.append(item);
  }

  dom.recipeStatuses.replaceChildren(fragment);
}

function formatStatus(status) {
  const statusValue = status && typeof status === "object" ? status.level : status;
  return String(statusValue || "labs").replace(/[-_]/g, " ");
}

function toggleConnector(connector) {
  const key = connector.kind === "delivery" ? "deliveryIds" : "sourceIds";
  const currentlySelected = appState.selection[key];
  appState.selection[key] = currentlySelected.includes(connector.id)
    ? currentlySelected.filter((id) => id !== connector.id)
    : [...currentlySelected, connector.id];

  if (connector.kind === "delivery" && appState.selection.deliveryIds.length === 0) {
    appState.selection.cadence = "manual";
    dom.cadence.value = "manual";
  }

  appState.plan = null;
  renderChoices();
  refreshReadiness();
}

function selectedInstallation() {
  return Array.from(dom.installation).find((input) => input.checked)?.value || "existing_agent";
}

function currentSelection() {
  return {
    sourceIds: [...appState.selection.sourceIds],
    deliveryIds: [...appState.selection.deliveryIds],
    cadence: appState.selection.deliveryIds.length > 0 ? appState.selection.cadence : "manual",
    installation: selectedInstallation(),
  };
}

function safeReadiness() {
  const selection = currentSelection();
  try {
    return getReadiness({
      recipe: appState.recipe,
      connectors: appState.registry.connectors,
      selection,
    });
  } catch (error) {
    console.error("Unable to check recipe readiness.", error);
    return {
      state: "preview",
      deployable: false,
      messages: ["Preview is still safe. Add a source and a destination before deploying."],
    };
  }
}

function isDeployable(readiness) {
  const hasValidSelections = appState.selection.sourceIds.length > 0 && appState.selection.deliveryIds.length > 0;
  return Boolean(readiness?.deployable && hasValidSelections);
}

function messagesFrom(result, fallbackMessages) {
  const messages = arrayOfStrings(result?.messages);
  return messages.length > 0 ? messages : fallbackMessages;
}

function refreshReadiness() {
  const hasDelivery = appState.selection.deliveryIds.length > 0;
  dom.cadenceFieldset.disabled = !hasDelivery;
  dom.cadence.disabled = !hasDelivery;
  dom.cadenceHelp.textContent = hasDelivery
    ? "Your choice is included in the reviewable plan."
    : "Choose a delivery destination to set a schedule.";

  appState.readiness = safeReadiness();
  const deployable = isDeployable(appState.readiness);
  const sourceCount = appState.selection.sourceIds.length;
  const deliveryCount = appState.selection.deliveryIds.length;

  dom.downloadButton.disabled = !deployable;
  dom.copyButton.disabled = !deployable;
  dom.readinessBadge.className = "readiness-badge";

  if (deployable) {
    dom.readinessBadge.classList.add("is-deployable");
    dom.readinessBadge.textContent = "Ready to review";
    dom.deployHelp.textContent = "Your plan has a source and a destination. Preview it before downloading or copying the handoff.";
  } else if (sourceCount === 0 && deliveryCount === 0) {
    dom.readinessBadge.classList.add("is-preview");
    dom.readinessBadge.textContent = "Preview ready";
    dom.deployHelp.textContent = "Preview any time. Add at least one source and one destination to unlock a deployment plan.";
  } else {
    dom.readinessBadge.classList.add("is-attention");
    dom.readinessBadge.textContent = "One more choice";
    dom.deployHelp.textContent = sourceCount === 0
      ? "Choose at least one information source to make this plan deployable."
      : "Choose at least one delivery destination to make this plan deployable.";
  }

  renderReadinessPreview(appState.readiness, deployable);
}

function renderReadinessPreview(readiness, deployable) {
  if (appState.plan) {
    return;
  }

  const fallback = deployable
    ? ["Your sources will be read, summarized, and delivered to your selected destination.", "You will review access in your own environment before anything becomes live."]
    : ["Preview is safe: nothing is connected or changed.", "A live plan needs one information source and one place to deliver the brief."];
  const messages = messagesFrom(readiness, fallback);

  dom.planTitle.textContent = deployable ? "Ready for your review" : "A safe first step";
  dom.planState.textContent = deployable ? "Reviewable" : "Preview";
  dom.planOverview.replaceChildren(makeParagraph(messages[0] || fallback[0], "plan-lede"));
  renderList(dom.reviewList, [
    ...messages.slice(1),
    "It starts read-only and never changes your connected tools on its own.",
    "This builder does not ask for or store any credentials.",
  ]);
  renderList(dom.verificationList, ["Run one test brief and check that it arrives in the destination you chose."]);
  renderList(dom.rollbackList, ["Pause the recipe in your agent, then remove access you no longer want it to have."]);
}

function makeParagraph(value, className) {
  const paragraph = document.createElement("p");
  paragraph.className = className;
  paragraph.textContent = value;
  return paragraph;
}

function renderList(element, values) {
  const uniqueValues = [...new Set(arrayOfStrings(values))];
  const listItems = (uniqueValues.length > 0 ? uniqueValues : ["No additional details yet."]).map((value) => {
    const item = document.createElement("li");
    item.textContent = value;
    return item;
  });
  element.replaceChildren(...listItems);
}

function actionText(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (item && typeof item === "object") {
        return item.action || item.summary || item.customer_action || "";
      }
      return "";
    })
    .filter((item) => typeof item === "string" && item.trim());
}

function safelyFormatTechnicalPlan(plan) {
  const safeTechnicalPlan = {
    state: plan?.state,
    deployable: Boolean(plan?.deployable),
    fileName: plan?.fileName || null,
    selectedSources: currentSelection().sourceIds,
    selectedDestinations: currentSelection().deliveryIds,
    cadence: currentSelection().cadence,
    installation: currentSelection().installation,
    blueprint: plan?.blueprint || null,
  };

  return JSON.stringify(safeTechnicalPlan, null, 2);
}

function displayPlan(plan) {
  const deployable = Boolean(plan?.deployable && appState.selection.sourceIds.length && appState.selection.deliveryIds.length);
  const summary = friendlySummary(plan?.summary, deployable);
  const defaultReview = [
    "It will only read the sources you selected.",
    "It will send the finished brief only to the destinations you selected.",
    "Any external message requires approval during setup.",
    "It cannot make changes to your tools without a later approval step.",
    "You will enter or approve access only in your own environment during setup.",
  ];
  const previewMessages = messagesFrom(plan, defaultReview);
  const customerActions = actionText(plan?.customerActions);
  const verification = arrayOfStrings(plan?.verification);
  const rollback = arrayOfStrings(plan?.rollback);

  dom.planTitle.textContent = deployable ? "Your reviewable plan" : "Your safe preview";
  dom.planState.textContent = deployable ? "Deployable" : "Preview";
  dom.planOverview.replaceChildren(makeParagraph(summary, "plan-lede"));
  renderList(dom.reviewList, [...previewMessages, ...customerActions, ...defaultReview]);
  renderList(dom.verificationList, verification.length > 0 ? verification : ["Run one test brief and confirm it reaches the destination you selected."]);
  renderList(dom.rollbackList, rollback.length > 0 ? rollback : ["Pause the recipe in your agent, then remove access you no longer want it to have."]);
  dom.technicalOutput.textContent = safelyFormatTechnicalPlan(plan);
}

function friendlySummary(summary, deployable) {
  if (typeof summary === "string" && summary.trim()) {
    return summary;
  }

  if (summary && typeof summary === "object") {
    const sources = arrayOfStrings(summary.sources);
    const delivery = arrayOfStrings(summary.delivery);
    const cadence = summary.cadence === "weekdays"
      ? "every weekday"
      : summary.cadence === "weekly"
        ? "once a week"
        : "when you ask";
    if (sources.length && delivery.length) {
      return `Your Founder Brief will read ${sources.join(", ")} and deliver a read-only summary to ${delivery.join(", ")} ${cadence}.`;
    }
  }

  return deployable
    ? "Your Founder Brief is ready for a final review before setup."
    : "This is a safe preview. Nothing has been connected or deployed.";
}

function compileCurrentPlan() {
  const selection = currentSelection();
  try {
    return compileFounderBrief({
      recipe: appState.recipe,
      connectors: appState.registry.connectors,
      selection,
    });
  } catch (error) {
    console.error("Unable to compile Founder Brief.", error);
    return {
      state: "preview",
      deployable: false,
      messages: ["This preview could not be compiled yet. Review your choices and try again."],
      summary: "Your choices remain local in this browser. Nothing has been connected or changed.",
      verification: ["Once the setup plan is available, run a test brief before relying on it."],
      rollback: ["No rollback is needed: nothing was deployed."],
    };
  }
}

function previewPlan() {
  appState.plan = compileCurrentPlan();
  displayPlan(appState.plan);
  const deployable = Boolean(appState.plan?.deployable && isDeployable(appState.readiness));
  showToast(deployable ? "Plan previewed. Review it before you hand it off." : "Preview ready. Nothing has been connected or changed.");
}

function planForExport() {
  const compiled = compileCurrentPlan();
  if (!compiled?.deployable || !isDeployable(appState.readiness)) {
    showToast("Add at least one source and one destination before creating a setup handoff.");
    return null;
  }

  appState.plan = compiled;
  displayPlan(compiled);
  return compiled;
}

function downloadRecipe() {
  const plan = planForExport();
  if (!plan) {
    return;
  }

  const payload = plan.blueprint || {
    recipe: appState.recipe.id,
    selection: currentSelection(),
    summary: plan.summary,
    customerActions: plan.customerActions,
    verification: plan.verification,
    rollback: plan.rollback,
  };
  const fileName = sanitizeFileName(plan.fileName || "founder-brief.agent-recipe.json");
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  showToast("Recipe downloaded. It contains no passwords, API keys, or private credentials.");
}

function sanitizeFileName(fileName) {
  const clean = String(fileName).replace(/[^a-z0-9._-]/gi, "-");
  return clean.endsWith(".json") ? clean : `${clean}.json`;
}

async function copySetupPrompt() {
  const plan = planForExport();
  if (!plan) {
    return;
  }

  const prompt = typeof plan.handoffPrompt === "string" && plan.handoffPrompt.trim()
    ? plan.handoffPrompt
    : "Set up this read-only Founder Brief using the attached recipe. Ask the owner to provide access only in their own environment. Do not store or print secrets. Verify one test brief, then explain how to pause or remove the recipe.";

  try {
    await navigator.clipboard.writeText(prompt);
    showToast("Setup prompt copied. Paste it into your preferred coding agent when you are ready.");
  } catch (error) {
    const copied = fallbackCopy(prompt);
    showToast(copied ? "Setup prompt copied." : "Your browser blocked copying. Open the technical details and copy the plan from there.");
  }
}

function fallbackCopy(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

function showToast(message) {
  window.clearTimeout(appState.toastTimer);
  dom.toast.textContent = message;
  dom.toast.classList.add("is-visible");
  appState.toastTimer = window.setTimeout(() => dom.toast.classList.remove("is-visible"), 4200);
}

function bindEvents() {
  dom.cadence.addEventListener("change", () => {
    appState.selection.cadence = dom.cadence.value;
    appState.plan = null;
    refreshReadiness();
  });

  dom.installation.forEach((input) => {
    input.addEventListener("change", () => {
      appState.selection.installation = selectedInstallation();
      appState.plan = null;
      refreshReadiness();
    });
  });

  dom.previewButton.addEventListener("click", previewPlan);
  dom.downloadButton.addEventListener("click", downloadRecipe);
  dom.copyButton.addEventListener("click", copySetupPrompt);
}

async function initialise() {
  bindEvents();
  appState.registry = await loadRegistry();
  appState.recipe = appState.registry.recipes.find((recipe) => recipe.id === "founder-brief") || fallbackRegistry.recipes[0];
  renderChoices();
  renderRecipeStatuses();
  refreshReadiness();
}

initialise();
