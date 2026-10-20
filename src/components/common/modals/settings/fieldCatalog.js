/**
 * The Integrations and AI Providers fields of the Settings dialog: for each
 * settings key, its label and where it sits (tab > sub-tab). This is the
 * ONE definition of those labels - settings/fields.jsx gives a Field or
 * Toggle with `forKey` its label from here (the panels pass no label of
 * their own), the sub-tab bars take their titles from here, and the
 * "Copy this device's settings to your account?" sheet names keys the way
 * the fields do (settings/CopySettingsSheet.jsx), grouped the same way.
 * tests/settings-scope-ui.test.mjs checks the panels against it.
 *
 * Object order is display order: of the sub-tabs, and of the keys on the
 * copy sheet.
 */
export const SETTINGS_FIELDS = {
  integrations: {
    tab: 'Integrations',
    sections: {
      jira: {
        title: 'JIRA',
        fields: {
          JIRA_URL: 'Jira URL',
          JIRA_EMAIL: 'Jira Email Address',
          JIRA_PAT: 'Jira API Token',
        },
      },
      calendar: {
        title: 'Google Calendar',
        fields: {
          GOOGLE_CALENDAR_CLIENT_ID: 'OAuth 2.0 Client ID',
          GOOGLE_CALENDAR_CLIENT_SECRET: 'OAuth 2.0 Client Secret',
        },
      },
      huggingface: {
        title: 'HuggingFace',
        fields: {
          HF_TOKEN: 'HuggingFace Access Token',
          HF_EMBEDDING_MODEL: 'Embedding Model',
        },
      },
    },
  },
  ai: {
    tab: 'AI Providers',
    sections: {
      default: {
        title: 'Default Settings',
        fields: {
          DEFAULT_AI_PROVIDER: 'Default AI Provider',
          DEFAULT_AI_MODEL: 'Default AI Model',
          DEFAULT_AI_TEMPERATURE: 'Default Temperature',
          DEFAULT_AI_MAX_TOKENS: 'Default Max Tokens',
        },
      },
      openai: {
        title: 'OpenAI',
        fields: {
          OPENAI_API_KEY: 'OpenAI API Key',
        },
      },
      anthropic: {
        title: 'Anthropic',
        fields: {
          ANTHROPIC_API_KEY: 'Anthropic API Key',
          ANTHROPIC_USE_BEDROCK: 'Use AWS Bedrock',
          AWS_REGION: 'AWS Region',
          ANTHROPIC_USE_VERTEX: 'Use Vertex AI',
          ANTHROPIC_GCP_PROJECT_ID: 'GCP Project ID',
          ANTHROPIC_GCP_LOCATION: 'GCP Location',
          ANTHROPIC_VERTEX_MODELS: 'Available Models',
        },
      },
      gemini: {
        title: 'Google Gemini',
        fields: {
          GEMINI_API_KEY: 'Gemini API Key',
          GEMINI_USE_VERTEX: 'Use Vertex AI',
          GEMINI_PROJECT_ID: 'GCP Project ID',
          GEMINI_LOCATION: 'GCP Location',
          GEMINI_VERTEX_MODELS: 'Available Models',
        },
      },
      custom: {
        title: 'Custom/Ollama',
        fields: {
          CUSTOM_AI_ENDPOINT: 'Custom Endpoint URL',
          CUSTOM_API_KEY: 'Custom API Key (Optional)',
        },
      },
      ssh: {
        title: 'AI Over SSH',
        fields: {
          SSH_AI_DISPLAY_NAME: 'Display Name',
          SSH_AI_HOST: 'SSH Hostname',
          SSH_AI_USER: 'SSH Username',
          SSH_AI_PASSWORD: 'SSH Password (Optional)',
          SSH_AI_COMMAND_INITIAL: 'Initial Message Command Template',
          SSH_AI_COMMAND_FOLLOWUP: 'Follow-up Message Command Template',
        },
      },
    },
  },
};

// key -> { label, tab, tabId, section, sectionId, order }
const INDEX = {};
let order = 0;
for (const [tabId, tab] of Object.entries(SETTINGS_FIELDS)) {
  for (const [sectionId, section] of Object.entries(tab.sections)) {
    for (const [key, label] of Object.entries(section.fields)) {
      INDEX[key] = { label, tab: tab.tab, tabId, section: section.title, sectionId, order: order++ };
    }
  }
}

/** Where a key is edited: { label, tab, tabId, section, sectionId, order } - or null for a key no field edits. */
export function settingsField(key) {
  return INDEX[key] || null;
}

/** The label the Settings field for `key` shows; the key itself when no field edits it. */
export function settingsFieldLabel(key) {
  return INDEX[key]?.label ?? key;
}

/** The sub-tabs of a tab ('integrations' | 'ai') for SubTabs: [{ id, label }]. */
export function settingsSubTabs(tabId) {
  return Object.entries(SETTINGS_FIELDS[tabId].sections).map(([id, section]) => ({ id, label: section.title }));
}

/**
 * Keys grouped for display: [{ id, title ("AI Providers > Anthropic" or
 * null for keys no field edits, listed last), keys (in field order) }].
 */
export function groupSettingsKeys(keys) {
  const groups = new Map();
  const known = keys.filter((k) => INDEX[k]).sort((a, b) => INDEX[a].order - INDEX[b].order);
  for (const key of known) {
    const f = INDEX[key];
    const id = `${f.tabId}-${f.sectionId}`;
    if (!groups.has(id)) groups.set(id, { id, title: `${f.tab} › ${f.section}`, keys: [] });
    groups.get(id).keys.push(key);
  }
  const unknown = keys.filter((k) => !INDEX[k]).sort();
  if (unknown.length) groups.set('other', { id: 'other', title: null, keys: unknown });
  return [...groups.values()];
}
