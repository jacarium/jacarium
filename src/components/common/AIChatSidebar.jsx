import { useState, useEffect, useRef, useMemo } from 'react';
import { scopedKey } from '../../utils/accountStorage';
import { Bot, Send, Trash2, Plus, Edit2, AlertCircle, RefreshCw, Code2, X, ChevronDown, FileJson, FileText, Trello, GitBranch, Eye, ChevronLeft, ChevronRight } from 'lucide-react';
import SidebarHeader from './sidebar/SidebarHeader';
import ResizableSidebar from '../ResizableSidebar';
import { getBackendUrl, apiFetch } from '../../utils/backendUrl';
import { useNotifications } from '../../contexts/NotificationContext';
import AIMessageMarkdown from './AIMessageMarkdown';
import { newConversationId, parseConversationId } from '../../utils/aiConversations';

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
  const [contextAdded, setContextAdded] = useState(false);
  const [contextData, setContextData] = useState(null);
  const [contextSent, setContextSent] = useState(false);
  const [backendStatus, setBackendStatus] = useState('checking');
  const [checkingBackend, setCheckingBackend] = useState(false);
  const [backendBannerDismissed, setBackendBannerDismissed] = useState(false);

  // Add CSS for code block wrapping
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `
      .ai-chat-message pre {
        white-space: pre-wrap !important;
        word-wrap: break-word !important;
        overflow-wrap: break-word !important;
        max-width: 100% !important;
        overflow-x: auto !important;
      }
      .ai-chat-message code {
        white-space: pre-wrap !important;
        word-wrap: break-word !important;
        overflow-wrap: break-word !important;
      }
      .ai-chat-message p {
        word-wrap: break-word !important;
        overflow-wrap: break-word !important;
      }
    `;
    document.head.appendChild(style);
    return () => document.head.removeChild(style);
  }, []);

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
  const [showContextModal, setShowContextModal] = useState(false);
  const [editedContextJson, setEditedContextJson] = useState('');

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

  const aiSettings = currentConversation?.settings || {
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
  console.log('[AI Chat] aiSettings:', aiSettings);
  const currentModelOption = modelOptions.find(
    opt => opt.provider === aiSettings.provider && opt.model === aiSettings.model
  ) || modelOptions[0];
  console.log('[AI Chat] Selected model option:', currentModelOption);

  const noModelsConfigured = modelOptions.length === 0;

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
      }
    } catch (err) {
      console.error('Failed to load models:', err);
    } finally {
      setLoadingModels(false);
    }
  }

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

  // Sanitize context data - replaces hostnames and IPs
  function sanitizeContextData(data) {
    function sanitizeValue(value) {
      if (typeof value === 'string') {
        // Replace IP addresses (IPv4)
        value = value.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, 'X.X.X.X');

        // Replace domain names (basic pattern)
        value = value.replace(/\b([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}\b/g, 'sanitized.domain');

        // Replace common hostname patterns
        value = value.replace(/\b(node|server|host|vm|worker|master|controller)-?\d+/gi, '$1-X');

        return value;
      }
      return value;
    }

    // Recursively sanitize object
    function sanitizeObject(obj) {
      if (Array.isArray(obj)) {
        return obj.map(item => sanitizeObject(item));
      } else if (obj !== null && typeof obj === 'object') {
        const sanitized = {};
        for (const key in obj) {
          sanitized[key] = sanitizeObject(obj[key]);
        }
        return sanitized;
      } else {
        return sanitizeValue(obj);
      }
    }

    return sanitizeObject(data);
  }

  // Listen for context added from tab right-click
  useEffect(() => {
    function handleContextAdded(event) {
      const { contextType, contextData } = event.detail;
      console.log('[AI Chat] Context added via event:', contextType, contextData);
      // Automatically sanitize context when adding
      const sanitized = sanitizeContextData(contextData);
      setContextData({ type: contextType, data: sanitized });
      setContextAdded(true);
      setContextSent(false);
    }

    window.addEventListener('addAIContext', handleContextAdded);
    return () => window.removeEventListener('addAIContext', handleContextAdded);
  }, []);

  function handleRemoveContext() {
    setContextData(null);
    setContextAdded(false);
    setContextSent(false);
  }

  function handleOpenContextModal() {
    // Automatically sanitize when opening modal
    const sanitized = sanitizeContextData(contextData.data);
    // Convert \n to actual newlines for better readability in the editor
    setEditedContextJson(JSON.stringify(sanitized, null, 2).replace(/\\n/g, '\n'));
    setShowContextModal(true);
  }

  function handleSaveContextChanges() {
    try {
      // Parse the edited JSON by properly handling newlines
      // Strategy: Replace actual newlines that appear within string values with \\n
      let result = '';
      let inString = false;
      let escapeNext = false;

      for (let i = 0; i < editedContextJson.length; i++) {
        const char = editedContextJson[i];

        if (escapeNext) {
          result += char;
          escapeNext = false;
          continue;
        }

        if (char === '\\') {
          result += char;
          escapeNext = true;
          continue;
        }

        if (char === '"') {
          inString = !inString;
          result += char;
          continue;
        }

        if (char === '\n' && inString) {
          // Inside a string value, convert actual newline to \\n
          result += '\\n';
          continue;
        }

        result += char;
      }

      const parsed = JSON.parse(result);
      setContextData({ ...contextData, data: parsed });
      setContextSent(false); // Reset so new context is sent on next message
      // Don't close modal - allow user to continue editing/sanitizing
    } catch (error) {
      console.error('JSON parse error:', error);
      addNotification({
        type: 'error',
        title: 'Invalid JSON',
        message: 'Invalid JSON format. Cannot save changes. Please check the syntax.'
      });
    }
  }

  // Get icon for context type
  function getContextIcon(contextType) {
    if (contextType.includes('Document')) return FileText;
    if (contextType.includes('Kanban')) return Trello;
    if (contextType.includes('Workflow')) return GitBranch;
    if (contextType.includes('Diagnostic')) return FileJson;
    if (contextType.includes('Text Selection')) return FileText;
    return FileJson;
  }

  async function handleSendMessage() {
    if (!inputMessage.trim() || isLoading || backendStatus === 'offline') return;

    // Prepare message content with context if added (only on first message)
    let messageContent = inputMessage;
    if (contextAdded && contextData && !contextSent) {
      const contextJson = JSON.stringify(contextData.data, null, 2);
      messageContent = `I'm providing context from the current page to help answer my questions:\n\nContext from ${contextData.type}:\n\`\`\`json\n${contextJson}\n\`\`\`\n\nQuestion: ${inputMessage}`;
      setContextSent(true); // Mark context as sent
    }

    const userMessage = { role: 'user', content: messageContent };
    const updatedMessages = [...messages, userMessage];

    setConversations(prev => prev.map(conv =>
      conv.id === currentConversationId
        ? { ...conv, messages: updatedMessages }
        : conv
    ));

    setInputMessage('');
    // Keep context persistent so user can ask multiple questions
    setIsLoading(true);

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
        body: JSON.stringify(requestBody)
      });

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
      settings: { ...defaultAISettings }
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

  function handleDeleteConversation(convId) {
    if (conversations.length === 1) return;

    setConversations(prev => {
      const filtered = prev.filter(c => c.id !== convId);
      if (currentConversationId === convId) {
        setCurrentConversationId(filtered[0].id);
      }
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

                {/* Delete conversation button */}
                <button
                  onClick={() => handleDeleteConversation(currentConversationId)}
                  disabled={conversations.length === 1}
                  className="p-1.5 text-os-text-muted hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-sm transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  title={conversations.length === 1 ? "Can't delete last conversation" : "Delete conversation"}
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
              >
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
                        handleDeleteConversation(conv.id);
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
                        className={`prose prose-xs max-w-none text-xs wrap-break-word overflow-hidden ${
 msg.role ==='user'?'prose-invert':''
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
          {/* Context Display */}
          {contextAdded && contextData && (
            <div className="mb-3 flex items-center justify-between p-2 bg-blue-50 border border-blue-200 rounded-sm text-xs">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                {(() => {
                  const ContextIcon = getContextIcon(contextData.type);
                  return <ContextIcon size={14} className="text-blue-600 shrink-0" />;
                })()}
                <span className="text-blue-800 font-medium truncate">
                  {contextData.type}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={handleOpenContextModal}
                  className="p-1 hover:bg-blue-100 rounded-sm transition-colors shrink-0"
                  title="View context data"
                >
                  <Eye size={14} className="text-blue-600" />
                </button>
                <button
                  onClick={handleRemoveContext}
                  className="p-1 hover:bg-blue-100 rounded-sm transition-colors shrink-0"
                  title="Remove context"
                >
                  <X size={14} className="text-blue-600" />
                </button>
              </div>
            </div>
          )}

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

        {/* Context Data Modal */}
        {showContextModal && contextData && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-9999" onClick={() => setShowContextModal(false)}>
            <div className="bg-os-modal rounded-lg shadow-xl max-w-4xl w-full max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
              {/* Modal Header */}
              <div className="px-6 py-4 border-b border-os-border flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {(() => {
                    const ContextIcon = getContextIcon(contextData.type);
                    return <ContextIcon size={18} className="text-blue-600" />;
                  })()}
                  <h3 className="text-lg font-semibold text-os-text-primary">
                    Edit Context Data: {contextData.type}
                  </h3>
                </div>
                <button
                  onClick={() => setShowContextModal(false)}
                  className="p-1.5 hover:bg-os-card-secondary rounded-sm transition-colors"
                  title="Close without saving"
                >
                  <X size={20} className="text-os-text-secondary" />
                </button>
              </div>

              {/* Modal Body */}
              <div className="flex-1 overflow-auto p-6">
                <textarea
                  value={editedContextJson}
                  onChange={(e) => setEditedContextJson(e.target.value)}
                  className="w-full h-full min-h-[400px] bg-os-input-bg text-os-text-primary border border-os-border rounded-sm p-4 text-xs font-mono resize-none focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                  spellCheck={false}
                />
              </div>

              {/* Modal Footer */}
              <div className="px-6 py-4 border-t border-os-border flex items-center justify-end gap-2">
                <button
                  onClick={() => setShowContextModal(false)}
                  className="px-4 py-2 bg-os-divider text-os-text-primary rounded-sm hover:bg-os-border transition-colors text-sm"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveContextChanges}
                  className="px-4 py-2 bg-blue-600 text-white rounded-sm hover:bg-blue-700 transition-colors text-sm"
                >
                  Save Changes
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </ResizableSidebar>
  );
}
