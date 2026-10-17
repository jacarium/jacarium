import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { scopedKey } from '../utils/accountStorage';
import { Bot, Send, MessageSquare, Plus, RefreshCw, ChevronDown, Search, Code2, Download, Database, Clock, User, AlertTriangle, Menu } from 'lucide-react';
import { getBackendUrl, apiFetch } from '../utils/backendUrl';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { useNotifications } from '../contexts/NotificationContext';
import ResizableSidebar from './ResizableSidebar';
import SidebarHeader from './common/sidebar/SidebarHeader';
import ConfirmationModal from './common/ConfirmationModal';
import DatasetSelectionModal from './AIChatPage/DatasetSelectionModal';
import AIMessageMarkdown from './common/AIMessageMarkdown';
import { MenuItemIcon } from './common/menus/MenuItemIcon';
import { useMobile } from '../contexts/MobileContext';
import MobilePageHeader from './mobile/MobilePageHeader';
import RowMenuButton from './mobile/RowMenuButton';
import { useCloseDrawerOn } from '../hooks/useCloseDrawerOn';
import { newConversationId, parseConversationId } from '../utils/aiConversations';

export default function AIChatPage() {
  const { addNotification } = useNotifications();
  const [conversations, setConversations] = useState([]);
  const [currentConversationId, setCurrentConversationId] = useState(null);
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [backendStatus, setBackendStatus] = useState('checking');
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [modelSearchQuery, setModelSearchQuery] = useState('');
  const [showRawMarkdown, setShowRawMarkdown] = useState(false);
  const [availableModels, setAvailableModels] = useState({
    anthropic: [],
    openai: [],
    gemini: [],
    ollama: [],
    ssh: []
  });
  const [defaultAISettings] = useState({
    provider: 'anthropic',
    model: 'claude-sonnet-4-5@20250929',
    temperature: 0,
    maxTokens: 2000
  });
  const [sshConnected, setSshConnected] = useState(false);
  const [conversationCounter, setConversationCounter] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [editingConversationId, setEditingConversationId] = useState(null);
  const [editingName, setEditingName] = useState('');
  const [contextMenu, setContextMenu] = useState(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [conversationToDelete, setConversationToDelete] = useState(null);
  const [showDatasetModal, setShowDatasetModal] = useState(false);
  const [conversationsLoaded, setConversationsLoaded] = useState(false);
  const [showSidebarMenu, setShowSidebarMenu] = useState(false);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const [innerSidebarVisible, setInnerSidebarVisible] = useLocalStorage('innerSidebarVisible', true);

  // Listen for inner sidebar visibility changes
  useEffect(() => {
    function handleInnerSidebarVisibilityChange(event) {
      setInnerSidebarVisible(event.detail.visible);
    }

    window.addEventListener('innerSidebarVisibilityChange', handleInnerSidebarVisibilityChange);
    return () => window.removeEventListener('innerSidebarVisibilityChange', handleInnerSidebarVisibilityChange);
  }, [setInnerSidebarVisible]);

  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const modelSelectorRef = useRef(null);
  const contextMenuRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const abortControllerRef = useRef(null);
  const sidebarMenuRef = useRef(null);

  const currentConversation = conversations.find(c => c.id === currentConversationId) || conversations[0];
  // The phone layout: the page fills the shell (not the screen), the
  // conversation list is a drawer that closes when another chat is picked
  const { isMobile } = useMobile();
  const composerRef = useRef(null);
  // the phone's connection indicator clears the composer by its height
  useEffect(() => {
    if (!isMobile || !composerRef.current || typeof ResizeObserver === 'undefined') return undefined;
    const root = document.documentElement;
    const ro = new ResizeObserver(([entry]) => root.style.setProperty('--sc-composer-lift', `${Math.ceil(entry.contentRect.height + 20)}px`));
    ro.observe(composerRef.current);
    return () => { ro.disconnect(); root.style.removeProperty('--sc-composer-lift'); };
  }, [isMobile]);
  useCloseDrawerOn(currentConversationId);
  // Memoized so effects keyed on messages don't re-fire for the fresh []
  // created when a conversation has no messages yet
  const messages = useMemo(() => currentConversation?.messages || [], [currentConversation]);

  const aiSettings = currentConversation?.settings || defaultAISettings;

  // Build model options
  const modelOptions = [
    ...availableModels.anthropic.map(model => {
      if (typeof model === 'object' && model.id) {
        return {
          provider: 'anthropic',
          model: model.id,
          label: `Anthropic - ${model.label}`
        };
      } else {
        return {
          provider: 'anthropic',
          model,
          label: `Anthropic - ${model}`
        };
      }
    }),
    ...availableModels.openai.map(model => ({
      provider: 'openai',
      model,
      label: `OpenAI - ${model}`
    })),
    ...availableModels.gemini.map(model => {
      if (typeof model === 'object' && model.id) {
        return {
          provider: 'gemini',
          model: model.id,
          label: `Gemini - ${model.label}`
        };
      } else {
        return {
          provider: 'gemini',
          model,
          label: `Gemini - ${model}`
        };
      }
    }),
    ...availableModels.ollama.map(model => ({
      provider: 'ollama',
      model,
      label: `Ollama - ${model}`
    })),
    ...availableModels.ssh.map(model => ({
      provider: 'ssh',
      model: model.id,
      label: `SSH - ${model.label} (Remote)`,
      sshConfig: model.config
    }))
  ];

  const currentModelOption = modelOptions.find(
    opt => opt.provider === aiSettings.provider && opt.model === aiSettings.model
  ) || modelOptions[0];

  const noModelsConfigured = modelOptions.length === 0;

  // Filter conversations by search
  const filteredConversations = conversations.filter(conv =>
    conv.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  useEffect(() => {
    // In development React runs this effect twice (StrictMode); the first
    // run is cancelled by its cleanup so only one of them loads the
    // conversations - two loads racing before the first default chat was
    // saved used to create "New Chat 1" twice (loadConversations is
    // idempotent now as well).
    let cancelled = false;
    async function initializePage() {
      const isOnline = await checkBackendHealth();
      // Only load models if backend is online
      if (isOnline) {
        await loadAvailableModels();
      }
      if (!cancelled) loadConversations();
    }
    initializePage();
    return () => { cancelled = true; };
    // Intentional mount-only initialization
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load models when backend comes online
  useEffect(() => {
    if (backendStatus === 'online' && Object.keys(availableModels.anthropic || {}).length === 0) {
      loadAvailableModels();
    }
    // availableModels is only a has-it-already-loaded guard, not a trigger
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendStatus]);

  useEffect(() => {
    // Only auto-scroll if user hasn't scrolled up
    if (!userScrolledUp) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, userScrolledUp]);

  // Detect when user scrolls up
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 100; // 100px threshold

      if (isAtBottom) {
        setUserScrolledUp(false);
      } else {
        setUserScrolledUp(true);
      }
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  // Close model selector when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (modelSelectorRef.current && !modelSelectorRef.current.contains(event.target)) {
        setShowModelSelector(false);
      }
    };

    if (showModelSelector) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showModelSelector]);

  // Close context menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(event.target)) {
        setContextMenu(null);
      }
    };

    if (contextMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [contextMenu]);

  // Close sidebar menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (sidebarMenuRef.current && !sidebarMenuRef.current.contains(event.target)) {
        setShowSidebarMenu(false);
      }
    };

    if (showSidebarMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showSidebarMenu]);

  async function checkBackendHealth() {
    try {
      const backendUrl = await getBackendUrl();
      const response = await apiFetch(`${backendUrl}/api/ai/health`);
      if (response.ok) {
        setBackendStatus('online');
        return true;
      } else {
        setBackendStatus('offline');
        return false;
      }
    } catch {
      setBackendStatus('offline');
      return false;
    }
  }

  async function loadAvailableModels() {
    try {
      const backendUrl = await getBackendUrl();
      const response = await apiFetch(`${backendUrl}/api/ai/models`);

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
    } catch (error) {
      console.error('[AI Chat Page] Error fetching models:', error);
    }
  }

  function loadConversations() {
    const saved = localStorage.getItem(scopedKey('aiChatPageConversations'));
    const savedId = localStorage.getItem(scopedKey('aiChatPageCurrentConversation'));

    let parsed = null;
    if (saved) {
      try {
        parsed = JSON.parse(saved);
      } catch (error) {
        console.error('[AI Chat Page] Failed to parse saved conversations, starting fresh:', error);
        parsed = null;
      }
    }

    if (parsed && parsed.length > 0) {
      setConversations(parsed);
      // the stored current id: a number for a conversation from before the
      // UUID ids, else the UUID; one that no longer exists means the first
      const wanted = parseConversationId(savedId);
      const current = wanted != null && parsed.some((c) => c.id === wanted) ? wanted : parsed[0].id;
      setCurrentConversationId(current);
    } else {
      // The default chat of a fresh profile. Functional updates keep this
      // idempotent: a second load racing the first (StrictMode's double
      // effect, a remount) finds the chat already there and adds nothing.
      const newConv = {
        id: newConversationId(),
        name: 'New Chat 1',
        messages: [],
        createdAt: new Date().toISOString(),
        settings: {
          ...defaultAISettings,
          datasets: {
            documentIds: [],
            lastUpdated: null
          }
        }
      };
      setConversations(prev => (prev.length > 0 ? prev : [newConv]));
      setCurrentConversationId(prev => (prev != null ? prev : newConv.id));
      setConversationCounter(prev => Math.max(prev, 1));
    }
    setConversationsLoaded(true);
  }

  function createNewConversation() {
    const newCounter = conversationCounter + 1;
    const newConv = {
      id: newConversationId(),
      name: `New Chat ${newCounter}`,
      messages: [],
      createdAt: new Date().toISOString(),
      settings: {
        ...defaultAISettings,
        datasets: {
          documentIds: [],
          lastUpdated: null
        }
      }
    };
    setConversations(prev => [newConv, ...prev]);
    setCurrentConversationId(newConv.id);
    setConversationCounter(newCounter);
    setConversationsLoaded(true);
  }

  function selectModel(option) {
    const modelLabel = option.label.replace(/^(SSH - |Ollama - |Anthropic - |OpenAI - |Gemini - )/, '').replace(/ \(Remote\)$/, '');

    // If current conversation has no messages, just update its settings and name
    if (currentConversation && messages.length === 0) {
      setConversations(prev => prev.map(conv =>
        conv.id === currentConversationId
          ? {
              ...conv,
              name: modelLabel,
              settings: {
                provider: option.provider,
                model: option.model,
                temperature: 0,
                maxTokens: 2000,
                datasets: conv.settings.datasets || {
                  documentIds: [],
                  lastUpdated: null
                }
              }
            }
          : conv
      ));
    } else {
      // Create new conversation if there are already messages
      const newCounter = conversationCounter + 1;
      const modelLabel = option.label.replace(/^(SSH - |Ollama - |Anthropic - |OpenAI - |Gemini - )/, '').replace(/ \(Remote\)$/, '');
      const newConv = {
        id: newConversationId(),
        name: `${modelLabel} - Chat ${newCounter}`,
        messages: [],
        createdAt: new Date().toISOString(),
        settings: {
          provider: option.provider,
          model: option.model,
          temperature: 0,
          maxTokens: 2000,
          datasets: {
            documentIds: [],
            lastUpdated: null
          }
        }
      };
      setConversations(prev => [newConv, ...prev]);
      setCurrentConversationId(newConv.id);
      setConversationCounter(newCounter);
    }
    setShowModelSelector(false);
    setModelSearchQuery('');
  }

  function confirmDeleteConversation() {
    if (!conversationToDelete) return;

    const filtered = conversations.filter(c => c.id !== conversationToDelete);

    // If deleting the last conversation, create a new one
    if (filtered.length === 0) {
      const newConv = {
        id: newConversationId(),
        name: 'New Chat',
        messages: [],
        createdAt: new Date().toISOString(),
        settings: {
          ...defaultAISettings,
          datasets: {
            documentIds: [],
            lastUpdated: null
          }
        }
      };
      setConversations([newConv]);
      setCurrentConversationId(newConv.id);
    } else {
      setConversations(filtered);
      // If we deleted the current conversation, switch to the first remaining one
      if (currentConversationId === conversationToDelete) {
        setCurrentConversationId(filtered[0].id);
      }
    }

    setShowDeleteModal(false);
    setConversationToDelete(null);
  }

  function clearAllConversations() {
    // Clear all conversations and create a fresh one
    const newConv = {
      id: newConversationId(),
      name: 'New Chat',
      messages: [],
      createdAt: new Date().toISOString(),
      settings: {
        ...defaultAISettings,
        datasets: {
          documentIds: [],
          lastUpdated: null
        }
      }
    };
    setConversations([newConv]);
    setCurrentConversationId(newConv.id);
    setConversationCounter(0);
  }

  function startRename(conv) {
    setEditingConversationId(conv.id);
    setEditingName(conv.name);
  }

  function saveRename() {
    if (editingName.trim()) {
      setConversations(prev => prev.map(c =>
        c.id === editingConversationId ? { ...c, name: editingName.trim() } : c
      ));
    }
    setEditingConversationId(null);
    setEditingName('');
  }

  function exportConversation() {
    if (!currentConversation) return;

    const content = currentConversation.messages.map(msg =>
      `**${msg.role === 'user' ? 'You' : 'AI'}:**\n${msg.content}\n`
    ).join('\n---\n\n');

    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentConversation.name}.md`;
    a.click();
    URL.revokeObjectURL(url);

    addNotification({
      type: 'success',
      title: 'Exported',
      message: `Conversation exported as ${currentConversation.name}.md`
    });
  }

  function handleDatasetSave(documentIds) {
    setConversations(prev => prev.map(conv =>
      conv.id === currentConversationId
        ? {
            ...conv,
            settings: {
              ...conv.settings,
              datasets: {
                documentIds,
                lastUpdated: Date.now()
              }
            }
          }
        : conv
    ));
    setShowDatasetModal(false);
  }

  // Stable reference (useCallback) so it doesn't defeat the React.memo on
  // AIMessageMarkdown during streaming re-renders.
  const handleCitationClick = useCallback((docId) => {
    // Dispatch event to open document (same as Team Chat mentions)
    window.dispatchEvent(new CustomEvent('openDocument', {
      detail: { documentId: docId }
    }));
  }, []);

  function handleStopGeneration() {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsLoading(false);
    }
  }

  async function handleSendMessage() {
    if (!inputMessage.trim() || isLoading || backendStatus === 'offline' || noModelsConfigured) return;

    const userMessage = { role: 'user', content: inputMessage };
    const updatedMessages = [...messages, userMessage];

    // Reset scroll state when sending new message
    setUserScrolledUp(false);

    setConversations(prev => prev.map(conv =>
      conv.id === currentConversationId
        ? { ...conv, messages: updatedMessages }
        : conv
    ));

    setInputMessage('');
    setIsLoading(true);

    try {
      const backendUrl = await getBackendUrl();

      // Check if we should use RAG endpoint (only for Ollama - fully local)
      const datasets = aiSettings.datasets || {};
      const hasDatasets = (datasets.documentIds?.length || 0) > 0;
      const supportsRAG = aiSettings.provider === 'ollama';

      // Check if provider supports streaming
      const supportsStreaming = ['ollama', 'custom', 'anthropic'].includes(aiSettings.provider);

      let endpoint = `${backendUrl}/api/ai/chat`;
      const requestBody = {
        messages: updatedMessages,
        provider: aiSettings.provider,
        model: aiSettings.model,
        temperature: aiSettings.temperature,
        max_tokens: aiSettings.maxTokens
      };

      // Use RAG endpoint if datasets are selected and provider supports RAG
      if (hasDatasets && supportsRAG) {
        endpoint = `${backendUrl}/api/ai/chat-rag-stream`;
        requestBody.dataset_ids = datasets.documentIds;
        requestBody.retrieval_k = 5; // Top-5 chunks
      } else if (supportsStreaming) {
        // Use streaming endpoint for supported providers
        endpoint = `${backendUrl}/api/ai/chat-stream`;
      }

      if (aiSettings.provider === 'ssh' && currentModelOption?.sshConfig) {
        requestBody.sshConfig = {
          ...currentModelOption.sshConfig,
          conversationId: currentConversationId.toString()
        };
      }

      // Handle streaming response
      if (supportsStreaming || (hasDatasets && supportsRAG)) {
        await handleStreamingResponse(endpoint, requestBody, updatedMessages);
      } else {
        // Handle non-streaming response (fallback) - with abort support
        abortControllerRef.current = new AbortController();

        const response = await apiFetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: abortControllerRef.current.signal
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
        const assistantMessage = {
          role: 'assistant',
          content: data.message,
          citations: data.citations || []  // Store citations if present
        };

        setConversations(prev => prev.map(conv =>
          conv.id === currentConversationId
            ? { ...conv, messages: [...updatedMessages, assistantMessage] }
            : conv
        ));
      }

      if (aiSettings.provider === 'ssh') {
        setSshConnected(true);
      }
    } catch (error) {
      console.error('AI chat error:', error);

      // Don't show error message if user cancelled
      if (error.name === 'AbortError') {
        console.log('[AI Chat] Request aborted by user');
        return;
      }

      if (aiSettings.provider === 'ssh') {
        setSshConnected(false);
      }
      // Network-level failures (backend unreachable) surface as TypeError
      // from fetch; anything else carries a real error message from the
      // backend that the user needs to see (e.g. SSH key setup steps).
      const detail = (error instanceof TypeError || !error.message)
        ? 'Could not connect to AI backend. Please check that the server is running.'
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
      abortControllerRef.current = null;
    }
  }

  async function handleStreamingResponse(endpoint, requestBody, updatedMessages) {
    // Create abort controller for this request
    abortControllerRef.current = new AbortController();

    const response = await apiFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: abortControllerRef.current.signal
    });

    if (!response.ok) {
      let detail = '';
      try {
        const errData = await response.json();
        detail = errData.error || '';
      } catch {
        // Body wasn't JSON; fall back to the generic message.
      }
      throw new Error(detail || 'Failed to get AI response');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let content = '';
    let thinkingContent = '';
    let thinkingStartTime = null;

    // Create placeholder assistant message
    const assistantMessage = {
      role: 'assistant',
      content: '',
      thinking: null,
      thinkingExpanded: false
    };

    console.log('[Stream] Creating placeholder message, current messages:', updatedMessages.length);

    setConversations(prev => prev.map(conv =>
      conv.id === currentConversationId
        ? { ...conv, messages: [...updatedMessages, assistantMessage] }
        : conv
    ));

    // Buffer for partial SSE lines split across network chunks
    let sseBuffer = '';
    // Set when the backend sends its terminal 'done' event; stops the read
    // loop so nothing that might arrive afterwards is appended to the message
    let streamDone = false;

    try {
      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const combined = sseBuffer + chunk;
        const lines = combined.split('\n');
        // Last element is either '' (chunk ended on a newline) or a partial
        // line to carry over to the next read
        sseBuffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          let data;
          try {
            data = JSON.parse(line.slice(6));
          } catch (e) {
            console.error('Error parsing SSE data:', e);
            continue;
          }

          console.log('[Stream Debug] Received:', data);

          if (data.error) {
            // Backend-side failure mid-stream (e.g. Ollama timeout). Must
            // propagate out of handleStreamingResponse so handleSendMessage
            // shows it to the user - previously this throw was swallowed by
            // the same try/catch that guarded JSON.parse and the stream just
            // went silent, leaving a forever-loading empty bubble.
            throw new Error(data.error);
          }

          if (data.type === 'thinking_start') {
            thinkingStartTime = Date.now();
            thinkingContent = '';
          } else if (data.type === 'thinking_end') {
            const thinkingDuration = thinkingStartTime ? (Date.now() - thinkingStartTime) / 1000 : 0;

            // Update message with thinking section
            setConversations(prev => prev.map(conv => {
              if (conv.id === currentConversationId) {
                const msgs = [...conv.messages];
                const lastMsg = msgs[msgs.length - 1];
                msgs[msgs.length - 1] = {
                  ...lastMsg,
                  thinking: thinkingContent,
                  thinkingDuration: thinkingDuration
                };
                return { ...conv, messages: msgs };
              }
              return conv;
            }));
          } else if (data.type === 'thinking') {
            thinkingContent += data.content || '';

            // Update thinking content in real-time
            setConversations(prev => prev.map(conv => {
              if (conv.id === currentConversationId) {
                const msgs = [...conv.messages];
                const lastMsg = msgs[msgs.length - 1];
                // Don't set thinkingExpanded - let the display logic handle it
                msgs[msgs.length - 1] = { ...lastMsg, thinking: thinkingContent };
                return { ...conv, messages: msgs };
              }
              return conv;
            }));
          } else if (data.type === 'content') {
            content += data.content || '';

            console.log('[Stream] Content update, total length:', content.length);

            // Update content in real-time
            setConversations(prev => prev.map(conv => {
              if (conv.id === currentConversationId) {
                const msgs = [...conv.messages];
                const lastMsg = msgs[msgs.length - 1];

                if (!lastMsg) {
                  console.error('[Stream] No last message found!');
                  return conv;
                }

                // Don't set thinkingExpanded - let the display logic handle it
                // Add citations if present (from RAG endpoint)
                msgs[msgs.length - 1] = {
                  ...lastMsg,
                  content,
                  ...(data.citations ? { citations: data.citations } : {})
                };

                return { ...conv, messages: msgs };
              }
              return conv;
            }));
          } else if (data.type === 'done') {
            // Streaming complete - also exit the outer read loop (a bare
            // break here only left the inner for-loop, so bytes arriving
            // after 'done' were appended to the finished message)
            streamDone = true;
            break;
          }
        }
      }
    } finally {
      // Release the connection whether we exited via 'done', stream end, or
      // a thrown backend error (cancel on an already-closed stream is a no-op)
      reader.cancel().catch(() => {});
    }
  }

  useEffect(() => {
    // Only save to localStorage after conversations have been loaded
    if (conversationsLoaded) {
      localStorage.setItem(scopedKey('aiChatPageConversations'), JSON.stringify(conversations));
    }
  }, [conversations, conversationsLoaded]);

  useEffect(() => {
    // Only save to localStorage after conversations have been loaded
    if (conversationsLoaded && currentConversationId) {
      localStorage.setItem(scopedKey('aiChatPageCurrentConversation'), currentConversationId.toString());
    }
  }, [currentConversationId, conversationsLoaded]);

  // Show loading state while conversations are being loaded
  if (!conversationsLoaded) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-os-text-muted">Loading conversations...</div>
      </div>
    );
  }

  return (
    <div className={isMobile ? 'flex flex-1 min-h-0 h-full' : 'flex h-screen'}>
      {/* Resizable Sidebar - Conversations List */}
      {(innerSidebarVisible || isMobile) && (
        <ResizableSidebar
          defaultWidth={280}
          minWidth={200}
          maxWidth={500}
          storageKey="aiChatPageSidebarWidth"
          position="right"
        >
          <div className="h-full flex flex-col bg-os-card border-r border-os-border">
            {/* Sidebar Header */}
            <SidebarHeader
              title="Robin"
              subtitle={`${conversations.length} conversation${conversations.length !== 1 ? 's' : ''}`}
              icon={Bot}
              actions={
                <div className="flex items-center gap-1">
                  <button
                    onClick={createNewConversation}
                    className="p-1.5 text-os-text-muted hover:text-os-text-primary hover:bg-os-card-secondary rounded-sm transition-colors"
                    title="New chat"
                  >
                    <Plus size={16} />
                  </button>
                  <div className="relative">
                    <button
                      onClick={() => setShowSidebarMenu(!showSidebarMenu)}
                      className="p-1.5 text-os-text-muted hover:text-os-text-primary hover:bg-os-card-secondary rounded-sm transition-colors"
                      title="Menu"
                    >
                      <Menu size={16} />
                    </button>

                    {/* Dropdown Menu */}
                    {showSidebarMenu && (
                      <div
                        ref={sidebarMenuRef}
                        className="absolute right-0 top-full mt-1 bg-os-card border border-os-border rounded-lg shadow-lg z-50 min-w-[180px] py-1"
                      >
                        <button
                          onClick={() => {
                            clearAllConversations();
                            setShowSidebarMenu(false);
                          }}
                          className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-os-card-secondary flex items-center gap-2"
                        >
                          <MenuItemIcon action="delete" danger />
                          Clear All Conversations
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              }
            />

            {/* Conversation List */}
            <div className="flex-1 overflow-y-auto">
              {/* Search — sticky inside the scroll container; the wrapper band is transparent so
                  list content stays visible around the pill, while the opaque pill occludes it */}
              <div className="sticky top-0 z-10 px-3 pt-2 pb-2 pointer-events-none">
                <div className="relative pointer-events-auto">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-os-text-muted pointer-events-none" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search conversations..."
                    className="w-full pl-8 pr-3 py-1.5 text-xs rounded-full border border-os-input-border bg-os-input-bg text-os-text-primary placeholder:text-os-text-muted shadow-md outline-hidden focus:border-os-blue focus:ring-2 focus:ring-os-blue transition-all"
                  />
                </div>
              </div>
              {filteredConversations.map((conv) => (
                <div
                  key={conv.id}
                  data-drawer-pick="true"
                  className={`px-4 py-3 cursor-pointer transition-colors border-l-4 font-text ${
 conv.id === currentConversationId
 ?'bg-os-blue/10 border-os-blue'
 :'hover:bg-os-card-secondary border-transparent'
 }`}
                  onClick={() => setCurrentConversationId(conv.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({ conversationId: conv.id, x: e.clientX, y: e.clientY });
                  }}
                >
                  {editingConversationId === conv.id ? (
                    <input
                      type="text"
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onBlur={saveRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveRename();
                        if (e.key === 'Escape') {
                          setEditingConversationId(null);
                          setEditingName('');
                        }
                      }}
                      autoFocus
                      className="w-full px-2 py-1 text-xs border border-blue-500 rounded-sm bg-os-input-bg text-os-text-primary font-text focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden"
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <div
                      className="w-full flex items-center justify-between gap-2"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        startRename(conv);
                      }}
                    >
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <MessageSquare size={14} className={`shrink-0 ${
 conv.id === currentConversationId ?'text-os-blue':'text-os-text-muted'
 }`} />
                        <h3 className={`text-sm truncate cursor-pointer ${
 conv.id === currentConversationId ?'text-os-blue font-medium':'text-os-text-primary'
 }`}>
                          {conv.name}
                        </h3>
                      </div>
                      <span className="text-xs text-os-text-muted shrink-0">
                        {conv.messages.length}
                      </span>
                      <RowMenuButton label={`Actions for ${conv.name}`} onOpen={(e) => setContextMenu({ conversationId: conv.id, x: e.clientX, y: e.clientY })} />
                    </div>
                  )}
                </div>
              ))}

              {filteredConversations.length === 0 && (
                <div className="p-8 text-center text-xs text-os-text-muted">
                  {searchQuery ? 'No conversations match your search' : 'No conversations yet'}
                </div>
              )}
            </div>
          </div>
        </ResizableSidebar>
      )}

      {/* Main Chat Area */}
      <div className={`flex-1 flex flex-col ${isMobile ? 'min-w-0 min-h-0' : ''}`}>
        {/* The phone header: the conversation and its model, the drawer button */}
        {isMobile && (
          <MobilePageHeader title={currentConversation?.name || 'Robin'} subtitle={currentModelOption?.label || 'Robin'} />
        )}
        {/* Chat Header */}
        <div className={`${isMobile ? 'h-11 px-4' : 'h-16 px-6'} border-b border-os-border bg-os-card flex items-center justify-between`}>
          <div className="flex flex-col">
            {/* (the phone header above already names the conversation) */}
            {!isMobile && (
            <h2 className="text-sm font-semibold text-os-text-primary">
              {currentConversation?.name || 'AI Chat'}
            </h2>
            )}
            <div className="flex items-center gap-2">
              {!noModelsConfigured ? (
                <div className="relative">
                  <button
                    onClick={() => setShowModelSelector(!showModelSelector)}
                    className="flex items-center gap-1 text-[10px] text-os-text-muted hover:text-os-text-primary transition-colors"
                  >
                    <span>{currentModelOption?.label || 'Select model'}</span>
                    <ChevronDown size={10} />
                  </button>

                {/* Model Selector Dropdown */}
                {showModelSelector && (
                  <div
                    ref={modelSelectorRef}
                    className="absolute top-full left-0 mt-1 bg-os-card border border-os-border rounded-lg shadow-lg z-50 min-w-[280px] max-h-[400px] flex flex-col"
                  >
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
                        className="p-1 hover:bg-os-card-secondary rounded-sm transition-colors"
                        title="Refresh models"
                      >
                        <RefreshCw size={12} className="text-os-text-muted" />
                      </button>
                    </div>

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
                              <div className={`w-2 h-2 rounded-full ${sshConnected ?'bg-green-500':'bg-red-500'}`} />
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
              ) : (
                <span className="text-[10px] text-os-text-muted">No AI models configured</span>
              )}

              {/* Dataset indicator - Only show for Ollama (fully local) */}
              {messages.length > 0 && aiSettings.provider === 'ollama' && (() => {
                const datasets = aiSettings.datasets || { documentIds: [] };
                const docCount = datasets.documentIds?.length || 0;

                return docCount > 0 ? (
                  <button
                    onClick={() => setShowDatasetModal(true)}
                    className="flex items-center gap-1 text-[10px] text-os-text-muted hover:text-blue-500 transition-colors"
                    title="Manage datasets"
                  >
                    <span>
                      {docCount} {docCount === 1 ? 'dataset' : 'datasets'}
                    </span>
                  </button>
                ) : null;
              })()}
            </div>
          </div>

          {/* Header Actions */}
          <div className="flex items-center gap-2">
            {messages.length > 0 && (
              <>
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
                <button
                  onClick={exportConversation}
                  className="p-1.5 text-os-text-muted hover:text-os-text-primary hover:bg-os-card-secondary rounded-sm transition-colors"
                  title="Export conversation"
                >
                  <Download size={16} />
                </button>
              </>
            )}
          </div>
        </div>

        {/* Backend Status Banner */}
        {backendStatus === 'offline' && (
          <div className="px-4 py-2 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-200 text-sm flex items-center justify-between gap-2 border-b border-red-200 dark:border-red-800">
            <span>AI backend offline</span>
            <button
              onClick={checkBackendHealth}
              className="text-red-700 dark:text-red-300 hover:text-red-800 dark:hover:text-red-200"
              title="Retry connection"
            >
              <RefreshCw size={14} />
            </button>
          </div>
        )}

        {/* External Provider Warning */}
        {!noModelsConfigured && aiSettings.provider !== 'ollama' && aiSettings.provider !== 'ssh' && (
          <div className="px-4 py-3 bg-yellow-50 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-200 text-xs border-b border-yellow-200 dark:border-yellow-800">
            <div className="flex items-start gap-2">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <div>
                <p className="font-medium mb-1">Using External AI Provider</p>
                <p className="text-yellow-700 dark:text-yellow-300">
                  You are using a third-party AI service. Please comply with their terms and conditions.
                  Do not share confidential, personal, or sensitive information in your conversations.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Messages Area */}
        <div ref={messagesContainerRef} className="flex-1 overflow-y-auto px-6 py-4 bg-os-canvas">
          {noModelsConfigured ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <Bot size={64} className="text-os-text-muted mb-4 opacity-30" />
              <p className="text-sm font-medium text-os-text-primary">No AI Models Configured</p>
              <p className="text-xs text-os-text-muted mt-1">
                Configure AI providers in Application Settings to start chatting
              </p>
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full max-w-6xl mx-auto">
              {/* Welcome Header */}
              <div className="text-center mb-12">
                <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-linear-to-br from-blue-500 to-purple-600 mb-6">
                  <Bot size={40} className="text-white" />
                </div>
                <h2 className="text-2xl font-semibold text-os-text-primary mb-2">
                  Welcome to Robin
                </h2>
                <p className="text-sm text-os-text-muted max-w-md mx-auto">
                  Get AI-powered assistance by selecting datasets or starting a conversation directly.
                </p>
              </div>

              {/* Feature Cards Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full mb-8">
                {/* Datasets Card - Only show for Ollama (fully local) */}
                {aiSettings.provider === 'ollama' && (
                  <div
                    className="bg-os-card border border-os-border rounded-lg p-6 hover:border-blue-500 transition-colors cursor-pointer"
                    onClick={() => setShowDatasetModal(true)}
                  >
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                      <Database size={20} className="text-blue-500" />
                    </div>
                    <h3 className="text-sm font-semibold text-os-text-primary">Datasets</h3>
                  </div>
                  <p className="text-xs text-os-text-muted mb-4">
                    Select documents to enable RAG-powered question answering
                  </p>

                  {/* Show selection status */}
                  {(() => {
                    const { documentIds = [] } = currentConversation?.settings?.datasets || {};
                    const totalCount = documentIds.length;
                    return totalCount > 0 ? (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400">
                          <div className="w-2 h-2 rounded-full bg-blue-500"></div>
                          <span>{totalCount} dataset{totalCount !== 1 ? 's' : ''} selected</span>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 text-xs text-os-text-muted opacity-50">
                          <div className="w-2 h-2 rounded-full bg-os-text-muted"></div>
                          <span>No datasets selected</span>
                        </div>
                      </div>
                    );
                  })()}

                  <button
                    className="mt-4 w-full py-2 text-xs text-blue-600 bg-blue-500 hover:bg-blue-500/20/10 rounded-sm transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowDatasetModal(true);
                    }}
                  >
                    {currentConversation?.settings?.datasets?.documentIds?.length > 0
                      ? 'Manage Datasets'
                      : 'Select Datasets'}
                  </button>
                </div>
                )}

                {/* Recent Threads Card - Span both columns if Datasets is hidden */}
                <div className={`bg-os-card border border-os-border rounded-lg p-6 hover:border-green-500 transition-colors cursor-pointer ${
 aiSettings.provider !=='ollama'?'md:col-span-2':''
 }`}>
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 rounded-lg bg-green-500/10 flex items-center justify-center">
                      <Clock size={20} className="text-green-500" />
                    </div>
                    <h3 className="text-sm font-semibold text-os-text-primary">Recent Threads</h3>
                  </div>
                  <p className="text-xs text-os-text-muted mb-4">
                    Continue from where you left off
                  </p>
                  <div className="space-y-2">
                    {conversations.slice(0, 3).map((conv) => (
                      <button
                        key={conv.id}
                        onClick={() => setCurrentConversationId(conv.id)}
                        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-os-card-secondary transition-colors text-left"
                      >
                        <MessageSquare size={14} className="text-os-text-muted shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-os-text-primary truncate">{conv.name}</p>
                          <p className="text-[10px] text-os-text-muted">{conv.messages.length} messages</p>
                        </div>
                      </button>
                    ))}
                    {conversations.length === 0 && (
                      <div className="text-xs text-os-text-muted opacity-50 text-center py-2">
                        No recent conversations
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Quick Start Prompt */}
              <div className="w-full max-w-3xl">
                <p className="text-xs text-os-text-muted text-center mb-3">
                  Or type your message below to start chatting
                </p>
              </div>
            </div>
          ) : (
            <div className="sc-chat-messages space-y-4">
              {messages.map((msg, idx) => (
                <React.Fragment key={idx}>
                  {/* Main Message Bubble */}
                  <div className="sc-chat-message flex gap-4">
                    {/* Avatar */}
                    <div className="sc-chat-avatar shrink-0">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
 msg.role ==='user'
 ?'bg-blue-600'
 :'bg-linear-to-br from-blue-500 to-purple-600'
 }`}>
                        {msg.role === 'user' ? (
                          <User size={18} className="text-white" />
                        ) : (
                          <Bot size={18} className="text-white" />
                        )}
                      </div>
                    </div>

                    {/* Message Card */}
                    <div className="flex-1 min-w-0">
                      <div className="sc-chat-bubble bg-os-card border border-os-border rounded-lg shadow-xs">
                      {showRawMarkdown ? (
                        <div className="text-xs whitespace-pre-wrap wrap-break-word font-mono text-os-text-primary p-4">{msg.content}</div>
                      ) : msg.role === 'user' ? (
                        <div className="text-xs whitespace-pre-wrap wrap-break-word text-os-text-primary p-4">{msg.content}</div>
                      ) : (
                        <>
                          {/* Tabs for assistant messages with thinking */}
                          {msg.thinking && msg.content && (
                            <div className="border-b border-os-border">
                              <div className="flex gap-1 px-4 pt-2">
                                <button
                                  onClick={() => {
                                    setConversations(prev => prev.map(conv => {
                                      if (conv.id === currentConversationId) {
                                        const msgs = [...conv.messages];
                                        const msgIndex = msgs.findIndex(m => m === msg);
                                        if (msgIndex !== -1) {
                                          msgs[msgIndex] = {
                                            ...msgs[msgIndex],
                                            activeTab: 'reply'
                                          };
                                        }
                                        return { ...conv, messages: msgs };
                                      }
                                      return conv;
                                    }));
                                  }}
                                  className={`px-3 py-1.5 text-xs transition-colors border-b-2 -mb-px ${
 (msg.activeTab ||'reply') ==='reply'
 ?'border-blue-500 text-blue-600 dark:text-blue-400'
 :'border-transparent text-os-text-secondary hover:text-os-text-primary'
 }`}
                                >
                                  Reply
                                </button>
                                <button
                                  onClick={() => {
                                    setConversations(prev => prev.map(conv => {
                                      if (conv.id === currentConversationId) {
                                        const msgs = [...conv.messages];
                                        const msgIndex = msgs.findIndex(m => m === msg);
                                        if (msgIndex !== -1) {
                                          msgs[msgIndex] = {
                                            ...msgs[msgIndex],
                                            activeTab: 'thinking'
                                          };
                                        }
                                        return { ...conv, messages: msgs };
                                      }
                                      return conv;
                                    }));
                                  }}
                                  className={`px-3 py-1.5 text-xs transition-colors border-b-2 -mb-px ${
 msg.activeTab ==='thinking'
 ?'border-yellow-500 text-yellow-600 dark:text-yellow-400'
 :'border-transparent text-os-text-secondary hover:text-os-text-primary'
 }`}
                                >
                                  <span className="flex items-center gap-1">
                                    Thinking
                                    {msg.thinkingDuration && ` (${msg.thinkingDuration.toFixed(1)}s)`}
                                  </span>
                                </button>
                              </div>
                            </div>
                          )}

                          <div className="p-4">
                          {/*
                            Show thinking if:
                            - Thinking tab is active (user clicked it)
                            - OR content doesn't exist yet (still thinking)
                          */}
                          {msg.thinking && (msg.activeTab === 'thinking' || !msg.content || !msg.content.trim()) ? (
                            <div className="text-xs text-os-text-primary whitespace-pre-wrap wrap-break-word">
                              {msg.thinking}
                            </div>
                          ) : msg.content && msg.content.trim() ? (
                            /* Show reply tab content (default). Memoized per
                               message (content + citations) so streaming
                               chunks only re-parse the message actually
                               changing - see AIMessageMarkdown. */
                            <AIMessageMarkdown
                              content={msg.content}
                              citations={msg.citations}
                              onCitationClick={handleCitationClick}
                              className="prose prose-xs max-w-none text-xs dark:prose-invert [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_pre]:wrap-break-word"
                            />
                          ) : msg.content && !msg.content.trim() ? (
                            /* Content exists but is only whitespace - show a message */
                            <div className="text-xs text-os-text-muted italic">
                              (Empty response)
                            </div>
                          ) : (
                            /* Loading state - no content or thinking yet - show jumping dots */
                            <div className="flex items-center gap-1">
                              <div className="w-2 h-2 bg-os-text-muted rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                              <div className="w-2 h-2 bg-os-text-muted rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                              <div className="w-2 h-2 bg-os-text-muted rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
                            </div>
                          )}
                          </div>
                        </>
                      )}
                      </div>
                      {/* End of Message Card */}
                    </div>
                  {/* End of flex-1 min-w-0 */}
                </div>
                {/* End of Main Message Bubble flex gap-4 */}
                </React.Fragment>
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input Area (on a phone at the mockup's 12px margins, and measured
            so the connection indicator can sit above it: src/mobile.css) */}
        <div ref={composerRef} className={`border-t border-os-border bg-os-card ${isMobile ? 'px-3 py-2.5' : 'px-6 py-4'}`}>
          <div className="sc-chat-composer flex gap-3">
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
              className="flex-1 px-4 py-3 border border-os-border resize-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-hidden text-sm bg-os-input-bg text-os-text-primary disabled:bg-os-card-secondary disabled:text-os-text-muted"
              rows={isMobile ? 1 : 3}
            />
            {isLoading ? (
              <button
                onClick={handleStopGeneration}
                className="px-6 bg-red-700/80 text-white hover:bg-red-800/90 transition-colors flex items-center justify-center gap-2"
              >
                <div className="w-3 h-3 bg-os-card rounded-xs"></div>
                <span className="text-sm">Stop</span>
              </button>
            ) : (
              <button
                onClick={handleSendMessage}
                disabled={!inputMessage.trim() || backendStatus === 'offline' || noModelsConfigured}
                className="px-6 bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center"
              >
                <Send size={18} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="sc-context-menu fixed bg-os-card border border-os-border rounded-lg shadow-lg z-50 py-1.5 min-w-[180px]"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button
            onClick={() => {
              setConversationToDelete(contextMenu.conversationId);
              setShowDeleteModal(true);
              setContextMenu(null);
            }}
            className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-os-card-secondary flex items-center gap-2"
          >
            <MenuItemIcon action="delete" danger />
            Delete Chat
          </button>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      <ConfirmationModal
        isOpen={showDeleteModal && !!conversationToDelete}
        onClose={() => {
          setShowDeleteModal(false);
          setConversationToDelete(null);
        }}
        onConfirm={confirmDeleteConversation}
        title="Delete Chat"
        message={`Are you sure you want to delete "${conversations.find(c => c.id === conversationToDelete)?.name}"?\n\nThis action cannot be undone.`}
        confirmText="Delete Chat"
        dangerous={true}
      />

      {/* Dataset Selection Modal */}
      <DatasetSelectionModal
        isOpen={showDatasetModal}
        onClose={() => setShowDatasetModal(false)}
        selectedDocumentIds={aiSettings.datasets?.documentIds || []}
        onSave={handleDatasetSave}
      />
    </div>
  );
}
