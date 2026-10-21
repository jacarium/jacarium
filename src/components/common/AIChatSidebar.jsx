import { useState, useEffect, useRef, useMemo } from 'react';
import { scopedKey } from '../../utils/accountStorage';
import { Bot, Send, Trash2, Plus, Edit2, AlertCircle, RefreshCw, Code2, X, ChevronDown, FileJson, FileText, Trello, GitBranch, Eye, ChevronLeft, ChevronRight } from 'lucide-react';
import SidebarHeader from './sidebar/SidebarHeader';
import ResizableSidebar from '../ResizableSidebar';
import { getBackendUrl, apiFetch } from '../../utils/backendUrl';
import { useNotifications } from '../../contexts/NotificationContext';
import AIMessageMarkdown from './AIMessageMarkdown';
import { newConversationId, parseConversationId } from '../../utils/aiConversations';
import { resolveModelOption } from '../../utils/aiDefaults';
import AIContextDialog from './AIContextDialog';
import ConfirmationModal from './modals/ConfirmationModal';
import { buildContextMessage, newContext, renderContext } from '../../utils/aiContext';
import { usePrivacyLists } from '../../utils/aiPrivacy';

// Hoisted so the object reference is stable across renders - an inline
// object literal here would defeat AIMessageMarkdown's React.memo.
const MESSAGE_MARKDOWN_STYLE = {
  overflowWrap: 'break-word',
  wordWrap: 'break-word',
  wordBreak: 'break-word'
};

export default function AIChatSidebar({ isOpen }) {
  const { addNotification } = useNotifications();
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  // the device's never-hide / always-hide lists for the context redaction
  const privacyLists = usePrivacyLists();
  const [backendStatus, setBackendStatus] = useState('checking');
  const [checkingBackend, setCheckingBackend] = useState(false);
  const [backendBannerDismissed, setBackendBannerDismissed] = useState(false);


  // Track conversation counter
  const [conversationCounter, setConversationCounter] = useState(() => {
    const saved = localStorage.getItem(scopedKey('aiChatConversationCounter'));
    return saved ? parseInt(saved) : 1;
  });

  // Default AI settings (from environment)
  const [defaultAISettings, setDefaultAISettings] = useState({
    provider: 'anthropic',
    model: 'claude-sonnet-4-5@20250929',
    temperature: 0,
    maxTokens: 2000
  });

  // Conversations management
  const [conversations, setConversations] = useState(() => {
    const saved = localStorage.getItem(scopedKey('aiChatConversations'));
    if (saved) {
      const parsed = JSON.parse(saved);
      console.log('[AI Chat] Loading conversations from localStorage:', parsed);
      // Migrate old conversations without settings
      const migrated = parsed.map(conv => ({
        ...conv,
        settings: conv.settings || {
          provider: 'anthropic',
          model: 'claude-sonnet-4-5@20250929',
          temperature: 0,
          maxTokens: 2000
        }
      }));
      console.log('[AI Chat] Migrated conversations:', migrated);
      return migrated;
    }
    const defaultConv = {
      id: newConversationId(),
      name: 'Conversation 1',
      messages: [],
      createdAt: new Date().toISOString(),
      settings: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5@20250929',
        temperature: 0,
        maxTokens: 2000
      }
    };
    return [defaultConv];
  });

  const [currentConversationId, setCurrentConversationId] = useState(() => {
    // (a number for a conversation from before the UUID ids, else the UUID)
    const saved = parseConversationId(localStorage.getItem(scopedKey('aiChatCurrentConversation')));
    if (saved != null && conversations.some((c) => c.id === saved)) return saved;
    return conversations[0]?.id ?? newConversationId();
  });

  const [showConversations, setShowConversations] = useState(false);
  const [editingHeader, setEditingHeader] = useState(false);
  const [editingConversationName, setEditingConversationName] = useState('');
  const [showRawMarkdown, setShowRawMarkdown] = useState(false);
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [modelSearchQuery, setModelSearchQuery] = useState('');
  const [editingContextId, setEditingContextId] = useState(null);   // the context open in the eye dialog
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);     // the conversation the bin asks about
  const abortRef = useRef(null);                                    // the request in flight (deleting the chat aborts it)

  // Available providers (dynamically determined from environment)
  const [, setAvailableProviders] = useState([]);

  // Available models per provider
  const [availableModels, setAvailableModels] = useState({
    anthropic: [],
    openai: [],
    gemini: [],
    ollama: [],
    ssh: []
  });
  const [, setLoadingModels] = useState(false);

  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const headerInputRef = useRef(null);

  const currentConversation = conversations.find(c => c.id === currentConversationId) || conversations[0];
  // Memoized so effects keyed on messages don't re-fire for the fresh []
  // created when a conversation has no messages yet
  const messages = useMemo(() => currentConversation?.messages || [], [currentConversation]);
  // Load SSH config from localStorage/env
  const [sshConfig, setSshConfig] = useState({
    host: 'localhost',
    user: 'user',
    commandInitial: 'gemini -p "{{MESSAGE}}" -o json --session-id {{SESSION_ID}} | jq -r .response',
    commandFollowup: 'gemini -p "{{MESSAGE}}" -o json --resume {{SESSION_ID}} | jq -r .response',
    commandTimeout: ''
  });
  const [sshConnected, setSshConnected] = useState(false);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  // Settings > Default AI Provider / Model, as /api/ai/models reports them
  const [aiDefaults, setAiDefaults] = useState({ provider: '', model: '' });

  const savedSettings = currentConversation?.settings || {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5@20250929',
    temperature: 0,
    maxTokens: 2000,
    sshConfig: sshConfig
  };

  // Build model options dynamically from available models
  const modelOptions = [
    // Anthropic models - handle both object {id, label} and string formats
    ...availableModels.anthropic.map(model => {
      if (typeof model === 'object' && model.id) {
        // New format from API with display_name
        return {
          provider: 'anthropic',
          model: model.id,
          label: `Anthropic - ${model.label}`
        };
      } else {
        // Legacy string format
        return {
          provider: 'anthropic',
          model,
          label: `Anthropic - ${model}`
        };
      }
    }),
    // OpenAI models
    ...availableModels.openai.map(model => ({
      provider: 'openai',
      model,
      label: `OpenAI - ${model}`
    })),
    // Gemini models - handle both object {id, label} and string formats
    ...availableModels.gemini.map(model => {
      if (typeof model === 'object' && model.id) {
        // New format from Vertex API with display_name
        return {
          provider: 'gemini',
          model: model.id,
          label: `Gemini - ${model.label}`
        };
      } else {
        // Legacy string format
        return {
          provider: 'gemini',
          model,
          label: `Gemini - ${model}`
        };
      }
    }),
    // Ollama models (dynamically fetched)
    ...availableModels.ollama.map(model => ({
      provider: 'ollama',
      model,
      label: `Ollama - ${model}`
    })),
    // SSH models
    ...availableModels.ssh.map(model => ({
      provider: 'ssh',
      model: model.id,
      label: `SSH - ${model.label} (Remote)`,
      sshConfig: model.config  // Store SSH config for this model
    }))
  ];

  // Get current model label
  console.log('[AI Chat] Current conversation settings:', currentConversation?.settings);
  // the saved model when configured, else the Settings default model, else the
  // default provider's first, else the first configured (src/utils/aiDefaults.js)
  const currentModelOption = resolveModelOption(modelOptions, savedSettings, aiDefaults);
  console.log('[AI Chat] Selected model option:', currentModelOption);

  // The settings in force: the conversation's own when its model is among
  // the configured ones, else the first configured model's - the one the
  // header shows and a message is sent to (a fresh conversation carries
  // placeholder defaults; see AIChatPage for the "external provider" case).
  const aiSettings = currentModelOption
    && (currentModelOption.provider !== savedSettings.provider || currentModelOption.model !== savedSettings.model)
    ? { ...savedSettings, provider: currentModelOption.provider, model: currentModelOption.model }
    : savedSettings;
  console.log('[AI Chat] aiSettings:', aiSettings);

  // only once /api/ai/models has answered (or failed) does an empty list mean "nothing configured"
  const noModelsConfigured = modelsLoaded && modelOptions.length === 0;

  const modelSelectorRef = useRef(null);

  // Load available providers from environment
  async function loadAvailableProviders() {
    try {
      if (window.electronAPI?.readEnvFile) {
        const envVars = await window.electronAPI.readEnvFile();

        // Load default AI settings from environment
        const defaults = {
          provider: envVars.DEFAULT_AI_PROVIDER || 'anthropic',
          model: envVars.DEFAULT_AI_MODEL || 'claude-sonnet-4-5@20250929',
          temperature: parseFloat(envVars.DEFAULT_AI_TEMPERATURE || '0'),
          maxTokens: parseInt(envVars.DEFAULT_AI_MAX_TOKENS || '2000')
        };
        setDefaultAISettings(defaults);

        const providers = [];

        // Check for OpenAI
        if (envVars.OPENAI_API_KEY) {
          providers.push({ value: 'openai', label: 'OpenAI (GPT)' });
        }

        // Check for Anthropic (API key, Bedrock, or Vertex)
        if (envVars.ANTHROPIC_API_KEY ||
            envVars.ANTHROPIC_USE_BEDROCK === 'true' ||
            envVars.ANTHROPIC_USE_VERTEX === 'true') {
          providers.push({ value: 'anthropic', label: 'Anthropic (Claude)' });
        }

        // Check for Gemini (API key or Vertex)
        if (envVars.GEMINI_API_KEY || envVars.GEMINI_USE_VERTEX === 'true') {
          providers.push({ value: 'gemini', label: 'Google (Gemini)' });
        }

        // Check for Ollama endpoint
        if (envVars.CUSTOM_AI_ENDPOINT) {
          const isOllama = envVars.CUSTOM_AI_ENDPOINT.includes('ollama') ||
                          envVars.CUSTOM_AI_ENDPOINT.includes(':11434');
          if (isOllama) {
            providers.push({ value: 'ollama', label: 'Ollama' });
          } else {
            providers.push({ value: 'ollama', label: 'Custom Endpoint' });
          }
        }

        // Load SSH config from environment
        if (envVars.SSH_AI_HOST) {
          setSshConfig({
            host: envVars.SSH_AI_HOST || 'localhost',
            user: envVars.SSH_AI_USER || 'user',
            password: envVars.SSH_AI_PASSWORD || '',
            commandInitial: envVars.SSH_AI_COMMAND_INITIAL || 'gemini -p "{{MESSAGE}}" -o json --session-id {{SESSION_ID}} | jq -r .response',
            commandFollowup: envVars.SSH_AI_COMMAND_FOLLOWUP || 'gemini -p "{{MESSAGE}}" -o json --resume {{SESSION_ID}} | jq -r .response',
            commandTimeout: envVars.SSH_AI_COMMAND_TIMEOUT || ''
          });
          // Add SSH as an available provider
          providers.push({ value: 'ssh', label: 'SSH AI', icon: '🔌' });
        }

        // If no providers configured, show all options (backend will return appropriate errors)
        if (providers.length === 0) {
          providers.push(
            { value: 'anthropic', label: 'Anthropic (Claude)', icon: '🔮' },
            { value: 'openai', label: 'OpenAI (GPT)', icon: '🤖' },
            { value: 'gemini', label: 'Google (Gemini)', icon: '✨' },
            { value: 'ollama', label: 'Ollama', icon: '🦙' }
          );
        }

        setAvailableProviders(providers);

        // Update conversations if their provider is not available
        setConversations(prev => prev.map(conv => {
          if (!providers.find(p => p.value === conv.settings?.provider) && providers.length > 0) {
            return {
              ...conv,
              settings: { ...conv.settings, provider: providers[0].value }
            };
          }
          return conv;
        }));
      } else {
        // Not in Electron, show all providers
        setAvailableProviders([
          { value: 'anthropic', label: 'Anthropic (Claude)', icon: '🔮' },
          { value: 'openai', label: 'OpenAI (GPT)', icon: '🤖' },
          { value: 'gemini', label: 'Google (Gemini)', icon: '✨' },
          { value: 'ollama', label: 'Ollama', icon: '🦙' }
        ]);
      }
    } catch (error) {
      console.error('Error loading providers:', error);
      // Fallback to showing all providers
      setAvailableProviders([
        { value: 'anthropic', label: 'Anthropic (Claude)', icon: '🔮' },
        { value: 'openai', label: 'OpenAI (GPT)', icon: '🤖' },
        { value: 'gemini', label: 'Google (Gemini)', icon: '✨' },
        { value: 'ollama', label: 'Ollama', icon: '🦙' }
      ]);
    }
  }

  // Load available models from backend
  async function loadAvailableModels() {
    setLoadingModels(true);
    try {
      const backendUrl = await getBackendUrl();
      const response = await apiFetch(`${backendUrl}/api/ai/models`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000)
      });

      if (response.ok) {
        const models = await response.json();
        setAvailableModels({
          anthropic: models.anthropic || [],
          openai: models.openai || [],
          gemini: models.gemini || [],
          ollama: models.ollama || [],
          ssh: models.ssh || []
        });
        setAiDefaults({ provider: models.defaults?.provider || '', model: models.defaults?.model || '' });
      }
    } catch (err) {
      console.error('Failed to load models:', err);
    } finally {
      setLoadingModels(false);
      setModelsLoaded(true);
    }
  }

  // What a chat starts with (see AIChatPage.newChatSettings): the resolved
  // option once the list is known, else the placeholder defaults
  function newChatSettings() {
    const option = resolveModelOption(modelOptions, null, aiDefaults);
    return option ? { ...defaultAISettings, provider: option.provider, model: option.model } : { ...defaultAISettings };
  }

  // A chat that has not started and whose saved model is not configured
  // takes the resolved option once the list is known (stored = shown = sent)
  useEffect(() => {
    if (!modelsLoaded || modelOptions.length === 0) return;
    // a one-off correction of stored settings once the list is known (a no-op
    // render otherwise: `prev` is returned unchanged)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConversations((prev) => {
      let changed = false;
      const next = prev.map((conv) => {
        if (conv.messages?.length) return conv;
        if (modelOptions.some((o) => o.provider === conv.settings?.provider && o.model === conv.settings?.model)) return conv;
        const option = resolveModelOption(modelOptions, null, aiDefaults);
        if (!option) return conv;
        changed = true;
        return { ...conv, settings: { ...conv.settings, provider: option.provider, model: option.model } };
      });
      return changed ? next : prev;
    });
    // modelOptions is derived from availableModels each render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelsLoaded, availableModels, aiDefaults]);

  // Check backend health
  async function checkBackendHealth() {
    setCheckingBackend(true);
    try {
      const backendUrl = await getBackendUrl();
      const response = await apiFetch(`${backendUrl}/api/ai/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000)
      });

      if (response.ok) {
        setBackendStatus('online');
      } else {
        setBackendStatus('offline');
      }
    } catch {
      setBackendStatus('offline');
    } finally {
      setCheckingBackend(false);
    }
  }

  useEffect(() => {
    if (isOpen) {
      // async health/model loaders; the sync setCheckingBackend arms the
      // spinner on purpose
      // eslint-disable-next-line react-hooks/set-state-in-effect
      checkBackendHealth();
      loadAvailableProviders();
      loadAvailableModels();
    }
  }, [isOpen]);

  // Save conversations to localStorage
  useEffect(() => {
    console.log('[AI Chat] Saving conversations to localStorage:', conversations);
    localStorage.setItem(scopedKey('aiChatConversations'), JSON.stringify(conversations));
  }, [conversations]);

  useEffect(() => {
    localStorage.setItem(scopedKey('aiChatCurrentConversation'), currentConversationId.toString());
  }, [currentConversationId]);

  useEffect(() => {
    localStorage.setItem(scopedKey('aiChatConversationCounter'), conversationCounter.toString());
  }, [conversationCounter]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input when editing header
  useEffect(() => {
    if (editingHeader && headerInputRef.current) {
      headerInputRef.current.focus();
      headerInputRef.current.select();
    }
  }, [editingHeader]);

  // Close model selector on click outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (modelSelectorRef.current && !modelSelectorRef.current.contains(event.target)) {
        setShowModelSelector(false);
      }
    }

    if (showModelSelector) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showModelSelector]);

  // "Add as AI Context" (a document, a board, a highlighted passage): a NEW
  // conversation on the Settings default provider / model, with the item's
  // CONTENT attached as a delimited block (src/utils/aiContext.js). The
  // redaction and the user's choices over it live on the context; the eye
  // on the chip (AIContextDialog) shows and edits exactly what is sent.
  const newChatSettingsRef = useRef(null);
  useEffect(() => { newChatSettingsRef.current = newChatSettings; });
  useEffect(() => {
    function handleContextAdded(event) {
      const payload = event.detail?.contextData;
      if (!payload || !payload.kind) { console.warn('[AI Chat] addAIContext without a payload'); return; }
      const context = newContext(payload);
      setConversationCounter((n) => {
        const counter = n + 1;
        const conv = {
          id: newConversationId(),
          name: `${payload.title || 'Context'} - Chat ${counter}`,
          messages: [],
          createdAt: new Date().toISOString(),
          settings: newChatSettingsRef.current ? newChatSettingsRef.current() : { ...defaultAISettings },
          contexts: [context],
          contextSent: false,
        };
        setConversations((prev) => [conv, ...prev]);
        setCurrentConversationId(conv.id);
        return counter;
      });
      setShowConversations(false);
    }
    window.addEventListener('addAIContext', handleContextAdded);
    return () => window.removeEventListener('addAIContext', handleContextAdded);
    // defaultAISettings only seeds a conversation before the models are known
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const contexts = currentConversation?.contexts || [];
  const contextSent = !!currentConversation?.contextSent;
  function updateConversation(patch) {
    setConversations((prev) => prev.map((conv) => (conv.id === currentConversationId ? { ...conv, ...patch } : conv)));
  }
  function updateContext(id, next) {
    updateConversation({ contexts: contexts.map((c) => (c.id === id ? { ...c, ...next } : c)), contextSent: false });
  }
  function removeContext(id) {
    updateConversation({ contexts: contexts.filter((c) => c.id !== id) });
  }
  // the source's current content for "Reset to the document / board"; a selection keeps its own text
  async function reloadContextSource(ctx) {
    try {
      if (ctx.source?.kind === 'document' && ctx.source.id != null) {
        const { getDocument } = await import('../../utils/documents');
        const doc = await getDocument(ctx.source.id);
        return doc ? String(doc.content ?? '') : null;
      }
      if (ctx.source?.kind === 'kanban' && ctx.source.id != null) {
        const { getBoard, getCards } = await import('../../utils/kanban');
        const { kanbanBoardMarkdown } = await import('../../utils/aiContext');
        const board = await getBoard(ctx.source.id);
        return board ? kanbanBoardMarkdown(board, await getCards(board.id)) : null;
      }
    } catch (err) {
      console.error('[AI Chat] Could not reload the context source:', err);
    }
    return null;
  }

  // Get icon for context type
  function getContextIcon(kind) {
    if (kind === 'kanban') return Trello;
    if (kind === 'workflow') return GitBranch;
    if (kind === 'diagnostics') return FileJson;
    return FileText;
  }

  async function handleSendMessage() {
    if (!inputMessage.trim() || isLoading || backendStatus === 'offline') return;

    // The contexts go with the first message, as the delimited blocks the
    // eye dialog shows (exactly that text), with the redaction note when a
    // placeholder is in them
    let messageContent = inputMessage;
    const sendContexts = contexts.length > 0 && !contextSent;
    if (sendContexts) {
      messageContent = buildContextMessage(contexts.map((ctx) => renderContext(ctx, privacyLists).text), inputMessage);
    }

    const userMessage = { role: 'user', content: messageContent };
    const updatedMessages = [...messages, userMessage];

    setConversations(prev => prev.map(conv =>
      conv.id === currentConversationId
        ? { ...conv, messages: updatedMessages, contextSent: sendContexts ? true : conv.contextSent }
        : conv
    ));

    setInputMessage('');
    // Keep context persistent so user can ask multiple questions
    setIsLoading(true);

    // the request can be abandoned (the bin while it runs): nothing lands then
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const backendUrl = await getBackendUrl();

      const requestBody = {
        messages: updatedMessages,
        provider: aiSettings.provider,
        model: aiSettings.model,
        temperature: aiSettings.temperature,
        max_tokens: aiSettings.maxTokens
      };

      // Add SSH config if provider is SSH
      if (aiSettings.provider === 'ssh') {
        requestBody.sshConfig = {
          host: sshConfig.host,
          user: sshConfig.user,
          password: sshConfig.password,
          commandInitial: sshConfig.commandInitial,
          commandFollowup: sshConfig.commandFollowup,
          commandTimeout: sshConfig.commandTimeout,
          conversationId: currentConversationId.toString()
        };
      }

      const response = await apiFetch(`${backendUrl}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
      if (controller.signal.aborted) return;

      if (!response.ok) {
        // Surface the backend's error detail (e.g. SSH auth setup
        // instructions) instead of a generic message.
        let detail = '';
        try {
          const errData = await response.json();
          detail = errData.error || '';
        } catch {
          // Body wasn't JSON; fall back to the generic message.
        }
        throw new Error(detail || 'Failed to get AI response');
      }

      const data = await response.json();
      const assistantMessage = { role: 'assistant', content: data.message };

      setConversations(prev => prev.map(conv =>
        conv.id === currentConversationId
          ? { ...conv, messages: [...updatedMessages, assistantMessage] }
          : conv
      ));

      // Update SSH connection status on success
      if (aiSettings.provider === 'ssh') {
        setSshConnected(true);
      }
    } catch (error) {
      if (error?.name === 'AbortError' || controller.signal.aborted) return;   // the chat was deleted or cleared meanwhile
      console.error('AI chat error:', error);

      // Update SSH connection status on failure
      if (aiSettings.provider === 'ssh') {
        setSshConnected(false);
      }

      // Network-level failures (backend unreachable) surface as TypeError
      // from fetch; anything else carries a real error message from the
      // backend that the user needs to see (e.g. SSH key setup steps).
      const detail = (error instanceof TypeError || !error.message)
        ? 'Could not connect to AI backend. Please check that the server is running on port 8080.\n\nIf you just configured AI settings, you may need to restart your application.'
        : error.message;
      const errorMessage = {
        role: 'assistant',
        content: `❌ Error: ${detail}`
      };
      setConversations(prev => prev.map(conv =>
        conv.id === currentConversationId
          ? { ...conv, messages: [...updatedMessages, errorMessage] }
          : conv
      ));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setIsLoading(false);
    }
  }

  function handleNewConversation() {
    const newCounter = conversationCounter + 1;
    const newConv = {
      id: newConversationId(),
      name: `Conversation ${newCounter}`,
      messages: [],
      createdAt: new Date().toISOString(),
      settings: newChatSettings()
    };
    setConversations(prev => [newConv, ...prev]);
    setCurrentConversationId(newConv.id);
    setConversationCounter(newCounter);
    setShowConversations(false);
  }

  function selectModel(option) {
    // Always create new conversation when selecting a model
    // This allows creating multiple conversations with the same model
    const currentSettings = currentConversation?.settings;

    const newCounter = conversationCounter + 1;
    const modelLabel = option.label.replace(/^(SSH - |Ollama - |Claude - )/, '');
    const newConv = {
      id: newConversationId(),
      name: `${modelLabel} - Chat ${newCounter}`,
      messages: [],
      createdAt: new Date().toISOString(),
      settings: {
        provider: option.provider,
        model: option.model,
        temperature: currentSettings?.temperature || 0,
        maxTokens: currentSettings?.maxTokens || 2000
      }
    };
    setConversations(prev => [newConv, ...prev]);
    setCurrentConversationId(newConv.id);
    setConversationCounter(newCounter);
    setShowModelSelector(false);
    setModelSearchQuery(''); // Clear search when closing
  }

  // The bin. One conversation: it is CLEARED in place (messages and contexts
  // gone, the default model applied - a fresh chat under the same id, so the
  // sidebar is never empty); several: that one is removed. A running request
  // is aborted first, so nothing lands in the emptied chat. A chat with
  // messages or context asks first; an empty one goes without asking.
  const conversationIsEmpty = (conv) => !(conv?.messages?.length) && !(conv?.contexts?.length);
  function requestDeleteConversation(convId) {
    const conv = conversations.find((c) => c.id === convId);
    if (!conv) return;
    if (conversationIsEmpty(conv)) deleteConversation(convId);
    else setConfirmDeleteId(convId);
  }
  function deleteConversation(convId) {
    setConfirmDeleteId(null);
    if (convId === currentConversationId && abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setIsLoading(false);
    }
    setConversations((prev) => {
      if (prev.length <= 1) {
        const only = prev[0];
        if (!only) return prev;
        return [{ ...only, messages: [], contexts: [], contextSent: false, settings: newChatSettings() }];
      }
      const filtered = prev.filter((c) => c.id !== convId);
      if (currentConversationId === convId) setCurrentConversationId(filtered[0].id);
      return filtered;
    });
  }

  function navigateToPreviousConversation() {
    const currentIndex = conversations.findIndex(c => c.id === currentConversationId);
    if (currentIndex < conversations.length - 1) {
      const nextConv = conversations[currentIndex + 1];
      console.log('[AI Chat] Navigating to previous conversation:', nextConv.name, 'Settings:', nextConv.settings);
      setCurrentConversationId(nextConv.id);
    }
  }

  function navigateToNextConversation() {
    const currentIndex = conversations.findIndex(c => c.id === currentConversationId);
    if (currentIndex > 0) {
      const nextConv = conversations[currentIndex - 1];
      console.log('[AI Chat] Navigating to next conversation:', nextConv.name, 'Settings:', nextConv.settings);
      setCurrentConversationId(nextConv.id);
    }
  }

  function handleRenameConversation(name) {
    if (!name.trim()) return;
    setConversations(prev => prev.map(conv =>
      conv.id === currentConversationId
        ? { ...conv, name: name.trim() }
        : conv
    ));
    setEditingHeader(false);
  }

  function startEditingHeader() {
    setEditingConversationName(currentConversation?.name || '');
    setEditingHeader(true);
  }

  if (!isOpen) return null;

  return (
    <ResizableSidebar
      defaultWidth={450}
      minWidth={350}
      maxWidth={600}
      storageKey="aiChatSidebarWidth"
      position="right"
    >
      <div className="flex flex-col h-full bg-os-card border-r border-os-border">
        {/* Header - Wrapper for header and dropdown */}
        <div className="relative">
          <SidebarHeader
            title={
              editingHeader ? (
                <input
                  ref={headerInputRef}
                  type="text"
                  value={editingConversationName}
                  onChange={(e) => setEditingConversationName(e.target.value)}
                  onBlur={() => handleRenameConversation(editingConversationName)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRenameConversation(editingConversationName);
                    if (e.key === 'Escape') setEditingHeader(false);
                  }}
                  className="px-2 py-1 border border-blue-500 rounded-sm text-sm bg-os-input-bg text-os-text-primary"
                />
              ) : (
                <div className="flex flex-col w-full">
                  {/* Conversation name and edit */}
                  <div className="flex items-center gap-2">
                    <span className="truncate">{currentConversation?.name || 'AI Chat'}</span>
                    <button
                      onClick={startEditingHeader}
                      className="p-1 hover:bg-os-card-secondary rounded-sm shrink-0"
                      title="Rename conversation"
                    >
                      <Edit2 size={12} />
                    </button>
                  </div>

                  {/* Model indicator */}
                  {noModelsConfigured ? (
                    <span className="text-[10px] text-os-text-muted font-normal mt-0.5">
                      No AI models configured
                    </span>
                  ) : (
                    <button
                      onClick={() => setShowModelSelector(!showModelSelector)}
                      className="flex items-center gap-1 text-[10px] text-os-text-muted font-normal hover:text-os-text-primary transition-colors mt-0.5"
                    >
                      <span>{currentModelOption?.label || 'Select model'}</span>
                      <ChevronDown size={10} />
                    </button>
                  )}
                </div>
              )
            }
            icon={Bot}
            actions={
              <>
                {/* Navigation arrows */}
                <button
                  onClick={navigateToPreviousConversation}
                  disabled={conversations.findIndex(c => c.id === currentConversationId) === conversations.length - 1}
                  className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  title="Previous conversation"
                >
                  <ChevronLeft size={16} className="text-os-text-secondary" />
                </button>
                <button
                  onClick={navigateToNextConversation}
                  disabled={conversations.findIndex(c => c.id === currentConversationId) === 0}
                  className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  title="Next conversation"
                >
                  <ChevronRight size={16} className="text-os-text-secondary" />
                </button>

                {messages.length > 0 && (
                  <button
                    onClick={() => setShowRawMarkdown(!showRawMarkdown)}
                    className={`p-1.5 transition-colors ${
 showRawMarkdown
 ?'text-os-blue bg-os-blue/10'
 :'text-os-text-muted hover:text-os-text-primary hover:bg-os-card-secondary'
 }`}
                    title={showRawMarkdown ? 'Show rendered markdown' : 'Show raw markdown'}
                  >
                    <Code2 size={16} />
                  </button>
                )}

                {/* Delete / clear conversation button: with one conversation the bin clears it; disabled only when there is nothing to clear */}
                <button
                  onClick={() => requestDeleteConversation(currentConversationId)}
                  disabled={conversations.length === 1 && conversationIsEmpty(currentConversation)}
                  className="p-1.5 text-os-text-muted hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-sm transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  title={conversations.length === 1 ? (conversationIsEmpty(currentConversation) ? 'Nothing to clear' : 'Clear conversation') : 'Delete conversation'}
                  aria-label={conversations.length === 1 ? 'Clear conversation' : 'Delete conversation'}
                  data-testid="ai-chat-delete"
                >
                  <Trash2 size={16} />
                </button>
              </>
            }
          />

          {/* Model Selector Dropdown - Positioned outside header to avoid clipping */}
          {showModelSelector && (
            <div
              ref={modelSelectorRef}
              className="absolute top-full left-4 mt-1 bg-os-card border border-os-border rounded-lg shadow-lg z-50 min-w-[280px] max-h-[400px] flex flex-col"
            >
              {/* Search and refresh header */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-os-border">
                <input
                  type="text"
                  value={modelSearchQuery}
                  onChange={(e) => setModelSearchQuery(e.target.value)}
                  placeholder="Search models..."
                  className="flex-1 px-2 py-1 text-xs border border-os-input-border rounded-sm focus:ring-1 focus:ring-blue-500 focus:border-blue-500 outline-hidden bg-os-input-bg text-os-text-primary"
                  onClick={(e) => e.stopPropagation()}
                />
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    loadAvailableModels();
                    addNotification({
                      type: 'success',
                      title: 'Models Refreshed',
                      message: 'Available models have been refreshed'
                    });
                  }}
                  className="p-1 hover:bg-os-card-secondary rounded-sm transition-colors shrink-0"
                  title="Refresh available models"
                >
                  <RefreshCw size={12} className="text-os-text-muted" />
                </button>
              </div>

              {/* Model options - scrollable */}
              <div className="overflow-y-auto">
              {modelOptions.filter(option =>
                option.label.toLowerCase().includes(modelSearchQuery.toLowerCase())
              ).map((option) => (
                <button
                  key={`${option.provider}-${option.model}`}
                  onClick={() => selectModel(option)}
                  className={`w-full px-3 py-2 text-left text-xs hover:bg-os-card-secondary transition-colors ${
 option.provider === aiSettings.provider && option.model === aiSettings.model
 ?'bg-os-blue/10 text-os-text-primary'
 :'text-os-text-primary'
 }`}
                >
                  <div className="flex items-center gap-2">
                    {option.provider === 'ssh' && (
                      <div className={`w-2 h-2 rounded-full ${sshConnected ?'bg-green-500':'bg-red-500'}`} title={sshConnected ? 'SSH Connected' : 'SSH Disconnected'} />
                    )}
                    <span>{option.label}</span>
                  </div>
                </button>
              ))}

              {modelOptions.filter(option =>
                option.label.toLowerCase().includes(modelSearchQuery.toLowerCase())
              ).length === 0 && (
                <div className="px-3 py-2 text-xs text-os-text-muted text-center">
                  {modelSearchQuery ? 'No models match your search' : 'No models available'}
                </div>
              )}
              </div>
            </div>
          )}
        </div>

        {/* Backend Status Banner */}
        {backendStatus === 'offline' && !backendBannerDismissed && (
          <div className="px-4 py-2 bg-red-50 text-red-700 dark:text-red-200 text-sm flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <AlertCircle size={14} className="dark:text-red-300" />
              <span>AI backend offline</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={checkBackendHealth}
                disabled={checkingBackend}
                className="text-red-700 dark:text-red-300 hover:text-red-800 dark:hover:text-red-200 disabled:opacity-50"
                title="Check the AI backend again"
                aria-label="Check the AI backend again"
              >
                <RefreshCw size={14} className={checkingBackend ? 'animate-spin' : ''} />
              </button>
              <button
                onClick={() => setBackendBannerDismissed(true)}
                className="text-red-700 dark:text-red-300 hover:text-red-800 dark:hover:text-red-200"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        )}

        {/* Conversations List */}
        {showConversations && (
          <div className="border-b border-os-border bg-os-card">
            <div className="p-2 flex items-center justify-between border-b border-os-border">
              <span className="text-sm font-medium text-os-text-primary">Conversations</span>
              <button
                onClick={handleNewConversation}
                className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
              >
                <Plus size={16} className="text-os-text-secondary" />
              </button>
            </div>
            <div className="max-h-48 overflow-y-auto">
              {conversations.map(conv => (
                <div
                  key={conv.id}
                  className={`px-3 py-2 flex items-center justify-between cursor-pointer transition-colors ${
 conv.id === currentConversationId
 ?'bg-os-blue/10'
 :'hover:bg-os-card-secondary'
 }`}
                  onClick={() => {
                    setCurrentConversationId(conv.id);
                    setShowConversations(false);
                  }}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-os-text-primary truncate">{conv.name}</div>
                    <div className="text-xs text-os-text-muted">{conv.messages.length} messages</div>
                  </div>
                  {conversations.length > 1 && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        requestDeleteConversation(conv.id);
                      }}
                      className="p-1 text-red-600 hover:bg-red-100 dark:hover:bg-red-900/20 rounded-sm"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {noModelsConfigured ? (
            <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
              <AlertCircle size={48} className="text-red-600 dark:text-red-400 mb-4" />
              <p className="text-sm text-os-text-primary font-medium">No AI Models Configured</p>
              <p className="text-xs text-os-text-muted mt-1">Configure AI providers in Application Settings to use AI Chat</p>
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
              <p className="text-sm text-os-text-secondary">No messages yet</p>
              <p className="text-xs text-os-text-muted mt-1">Start a conversation with AI</p>
            </div>
          ) : (
            <>
              {messages.map((msg, idx) => (
                <div key={idx} className={`flex ${msg.role ==='user'?'justify-end':'justify-start'}`}>
                  <div
                    className={`ai-chat-message max-w-[85%] rounded-lg px-4 py-2 wrap-break-word ${
 msg.role ==='user'
 ?'bg-blue-600 text-white'
 :'bg-os-card-secondary text-os-text-primary'
 }`}
                  >
                    {!showRawMarkdown ? (
                      /* Memoized per message so streaming chunks only
                         re-parse the message actually changing. */
                      <AIMessageMarkdown
                        content={msg.content}
                        className={`markdown-preview sc-chat-markdown text-xs wrap-break-word overflow-hidden ${
 msg.role ==='user'?'sc-chat-markdown-user':''
 }`}
                        style={MESSAGE_MARKDOWN_STYLE}
                      />
                    ) : (
                      <div className="whitespace-pre-wrap text-sm wrap-break-word overflow-hidden" style={{
                        overflowWrap: 'break-word',
                        wordWrap: 'break-word',
                        wordBreak: 'break-word'
                      }}>{msg.content}</div>
                    )}
                  </div>
                </div>
              ))}
              {/* Loading Indicator */}
              {isLoading && (
                <div className="flex justify-start">
                  <div className="bg-os-card-secondary rounded-lg px-4 py-3">
                    <div className="flex gap-1">
                      <div className="w-2 h-2 bg-os-text-muted rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                      <div className="w-2 h-2 bg-os-text-muted rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                      <div className="w-2 h-2 bg-os-text-muted rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        {/* Input */}
        <div className="border-t border-os-border p-4">
          {/* The contexts: a chip each - its title, how much is hidden, the eye (what the AI receives), remove */}
          {contexts.map((ctx) => {
            const r = renderContext(ctx, privacyLists);
            const ContextIcon = getContextIcon(ctx.kind);
            return (
              <div key={ctx.id} className="mb-2 flex items-center justify-between p-2 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-sm text-xs" data-testid="ai-context-chip" data-context-id={ctx.id}>
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <ContextIcon size={14} className="text-blue-600 dark:text-blue-300 shrink-0" />
                  <span className="text-blue-800 dark:text-blue-200 font-medium truncate">{ctx.kind === 'selection' ? `Selection: ${ctx.title}` : ctx.kind === 'kanban' ? `Board: ${ctx.title}` : `Document: ${ctx.title}`}</span>
                  <span className="text-blue-700/70 dark:text-blue-300/70 shrink-0" data-testid="ai-context-summary">{r.edited ? '\u00b7 edited' : r.hidden ? `\u00b7 ${r.hidden} hidden` : ''}</span>
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => setEditingContextId(ctx.id)} className="p-1 hover:bg-blue-100 dark:hover:bg-blue-800/40 rounded-sm transition-colors shrink-0" title="What the AI receives" aria-label="What the AI receives" data-testid="ai-context-eye">
                    <Eye size={14} className="text-blue-600 dark:text-blue-300" />
                  </button>
                  <button type="button" onClick={() => removeContext(ctx.id)} className="p-1 hover:bg-blue-100 dark:hover:bg-blue-800/40 rounded-sm transition-colors shrink-0" title="Remove context" aria-label="Remove context" data-testid="ai-context-remove">
                    <X size={14} className="text-blue-600 dark:text-blue-300" />
                  </button>
                </div>
              </div>
            );
          })}

          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={inputMessage}
              onChange={(e) => setInputMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
              placeholder={noModelsConfigured ? 'No AI models configured...' : backendStatus === 'offline' ? 'AI backend offline...' : 'Type your message...'}
              disabled={isLoading || backendStatus === 'offline' || noModelsConfigured}
              className="flex-1 px-3 py-2 border border-os-border rounded-sm resize-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden text-sm bg-os-input-bg text-os-text-primary disabled:bg-os-card-secondary disabled:text-os-text-muted"
              rows={3}
            />
            <button
              onClick={handleSendMessage}
              disabled={!inputMessage.trim() || isLoading || backendStatus === 'offline' || noModelsConfigured}
              className="px-4 py-2 bg-blue-600 text-white rounded-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors h-[76px]"
            >
              <Send size={18} />
            </button>
          </div>
        </div>

        <ConfirmationModal isOpen={!!confirmDeleteId} type="danger" title={conversations.length === 1 ? 'Clear this conversation?' : 'Delete this conversation?'}
          message={conversations.length === 1 ? 'Its messages and context are removed and the chat starts fresh on the default model.' : `"${conversations.find((c) => c.id === confirmDeleteId)?.name || ''}" and its messages are removed.`}
          confirmLabel={conversations.length === 1 ? 'Clear' : 'Delete'} onConfirm={() => deleteConversation(confirmDeleteId)} onCancel={() => setConfirmDeleteId(null)} />
        {/* What the AI receives for a context, and the say over the redaction */}
        {editingContextId && contexts.some((c) => c.id === editingContextId) && (
          <AIContextDialog
            key={editingContextId}
            context={contexts.find((c) => c.id === editingContextId)}
            onSave={(next) => { updateContext(editingContextId, next); setEditingContextId(null); }}
            onCancel={() => setEditingContextId(null)}
            reload={() => reloadContextSource(contexts.find((c) => c.id === editingContextId))}
          />
        )}
      </div>
    </ResizableSidebar>
  );
}
