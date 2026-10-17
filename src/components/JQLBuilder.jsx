import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { flushSync } from 'react-dom';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { Trash2, Copy, Check, AlertCircle, Loader2, Save } from 'lucide-react';
import { createJiraFields } from '../jiraConfig';
import { generateJQL } from '../utils/jqlGenerator';
import { getJiraBaseUrl, isJiraConfigured, JIRA_NOT_CONFIGURED } from '../services/jiraApi';
import IntegrationNotConfigured from './common/IntegrationNotConfigured';
import {
  fetchAllJiraData,
  getCachedJiraData,
  clearCache,
  onCooldownChange,
  isInCooldown,
  getCooldownRemaining,
  fetchProjectMetadata,
  validateProject,
  markProjectAsInvalid,
  clearInvalidProjects,
} from '../services/jiraApi';
import { db } from '../db/database';
import { getShareableURL, getStateFromURL, clearURLState, decodeBuilderState } from '../utils/shareUtils';
import { saveTemplate, getCategories, updateTemplate, getTemplateById } from '../templates/jqlTemplates';
import {
  createEmptyGroup,
  addRuleToGroup,
  addGroupToGroup,
  removeItemFromGroup,
  updateRuleInGroup,
  updateItemConnector,
  convertLegacyRulesToGroup,
  convertGroupToLegacyRules,
  findItemById,
} from '../utils/groupHelpers';
import SearchableCombobox from './SearchableCombobox';
import SaveTemplateModal from './SaveTemplateModal';
import EditTemplateModal from './EditTemplateModal';
import CustomFieldsModal from './CustomFieldsModal';
import ImportJQLModal from './ImportJQLModal';
import VariableInputModal from './VariableInputModal';
import CreateCustomFieldsModal from './CreateCustomFieldsModal';
import CompactSidebar from './CompactSidebar';
// import Breadcrumbs from './Breadcrumbs'; // Commented out - can be restored later
import StatusIndicator from './StatusIndicator';
import { startCloudSync, stopCloudSync } from '../utils/cloudSync';
import HighlightedJQL from './HighlightedJQL';
import MultiValueInput from './MultiValueInput';
import ChatSidebar from './common/ChatSidebar';
import NotificationSidebar from './common/NotificationSidebar';
import DraftSidebar from './common/DraftSidebar';
import AIChatSidebar from './common/AIChatSidebar';
import CommandPalette from './CommandPalette';
import FloatingQuiz from './FloatingQuiz';
import { getCustomFields } from '../utils/customFields';
import { extractVariablesFromGroup, extractVariablesFromSortFields, replaceVariablesInGroup, replaceVariablesInSortFields } from '../utils/templateVariables';
import { useNotifications } from '../contexts/NotificationContext';
import useConnectionNotices from '../hooks/useConnectionNotices';
import { useMobile } from '../contexts/MobileContext';
import MobileBottomNav from './mobile/MobileBottomNav';
import MoreSheet from './mobile/MoreSheet';
import MobileSettingsHost from './mobile/MobileSettingsHost';
import MobileMenuChrome from './mobile/MobileMenuChrome';
import { ForcedDrawerScope } from './mobile/MobileDrawer';

// Page-level components are lazy-loaded so each page ships in its own chunk.
// In Electron the chunks load from local disk, so the win is deferred JS
// parse/compile and lower memory footprint for tabs the user never opens in a
// session - not network latency. Cross-cutting startup work (cloud sync /
// WebSocket connection) is unaffected: it is initiated by startCloudSync() in
// this component's useEffect and by the eagerly-loaded ChatContext, not by
// module-level side effects in any of these page modules.
const DocumentsPage = lazy(() => import('./DocumentsPage'));
const CalendarsPage = lazy(() => import('./CalendarsPage'));
const DiagnosticsPage = lazy(() => import('./DiagnosticsPage'));
const SearchPage = lazy(() => import('./SearchPage'));
const WorkflowBuilder = lazy(() => import('./WorkflowBuilder'));
const ToolsPage = lazy(() => import('./ToolsPage'));
const KanbanPage = lazy(() => import('./KanbanPage'));
const TasksPage = lazy(() => import('./TasksPage'));
const TaskReportsPage = lazy(() => import('./TaskReportsPage'));
const AIChatPage = lazy(() => import('./AIChatPage'));

// Minimal fallback shown while a page chunk is parsed; mirrors the app's
// existing Loader2 + animate-spin loading convention.
function PageLoadingFallback() {
  return (
    <div className="flex-1 h-full bg-os-masthead min-w-0 overflow-hidden flex items-center justify-center">
      <Loader2 className="animate-spin text-os-text-secondary" size={24} />
    </div>
  );
}

export default function JQLBuilder({ standalone }) {
  const { addNotification } = useNotifications();

  // Restore JQL builder session from localStorage
  const restoreSearchSession = () => {
    try {
      const saved = localStorage.getItem('jacarium-session');
      if (saved) {
        const session = JSON.parse(saved);
        console.log('[JQLBuilder] Restored session:', session);
        return session;
      }
    } catch (error) {
      console.error('[JQLBuilder] Failed to restore search session:', error);
    }
    console.log('[JQLBuilder] No saved session found');
    return null;
  };

  const savedSession = restoreSearchSession();

  const [rootGroup, setRootGroup] = useState(savedSession?.rootGroup || createEmptyGroup('AND'));
  const [jql, setJql] = useState('');
  const [copied, setCopied] = useState(false);
  const [jiraFields, setJiraFields] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // Jira is optional: null until known, false shows the "Jira isn't set up" state and stops every load
  const [jiraConfigured, setJiraConfigured] = useState(null);
  const refreshRef = useRef(null);
  const [cooldown, setCooldown] = useState(0);
  const [projectOptions, setProjectOptions] = useState([]);
  const [selectedProject, setSelectedProject] = useState(savedSession?.selectedProject || null);
  const [projectMetadata, setProjectMetadata] = useState(null);
  const [loadingMetadata, setLoadingMetadata] = useState(false);
  const [saveTemplateModalOpen, setSaveTemplateModalOpen] = useState(false);
  const [editTemplateModalOpen, setEditTemplateModalOpen] = useState(false);
  const [customFieldsModalOpen, setCustomFieldsModalOpen] = useState(false);
  const [importJQLModalOpen, setImportJQLModalOpen] = useState(false);
  const [importQueryModalOpen, setImportQueryModalOpen] = useState(false);
  const [templateToEdit, setTemplateToEdit] = useState(null);
  const [shareUrlCopied, setShareUrlCopied] = useState(false);
  const [templateRefreshKey, setTemplateRefreshKey] = useState(0);
  const [currentPage, setCurrentPage] = useState(standalone || 'documents');
  const { isMobile } = useMobile();
  const [activeTemplateId, setActiveTemplateId] = useState(savedSession?.activeTemplateId || null);
  const [sortFields, setSortFields] = useState(savedSession?.sortFields || []);
  const [invalidProject, setInvalidProject] = useState(null);
  const [suggestedProjects, setSuggestedProjects] = useState([]);
  const [comboboxKey, setComboboxKey] = useState(0);
  const [customFieldsVersion, setCustomFieldsVersion] = useState(0);
  const [variableInputModalOpen, setVariableInputModalOpen] = useState(false);
  const [pendingTemplate, setPendingTemplate] = useState(null);
  const [templateVariables, setTemplateVariables] = useState([]);
  const [createCustomFieldsModalOpen, setCreateCustomFieldsModalOpen] = useState(false);
  const [detectedCustomFields, setDetectedCustomFields] = useState([]);
  const [pendingImportGroup, setPendingImportGroup] = useState(null);
  const [categories, setCategories] = useState([]);
  const [activeTemplateName, setActiveTemplateName] = useState(savedSession?.activeTemplateName || '');
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [selectedDocumentId, setSelectedDocumentId] = useState(null);
  const [createNewDocument, setCreateNewDocument] = useState(false);
  const [selectedEngineTemplate, setSelectedEngineTemplate] = useState(null);
  const [copiedRule, setCopiedRule] = useState(null);

  // Sidebar state (persisted across page changes)
  const [isChatSidebarOpen, setIsChatSidebarOpen] = useLocalStorage('chatSidebarOpen', false);
  const [isNotificationSidebarOpen, setIsNotificationSidebarOpen] = useLocalStorage('notificationSidebarOpen', false);
  const [isDraftSidebarOpen, setIsDraftSidebarOpen] = useLocalStorage('draftSidebarOpen', false);
  const [isAIChatSidebarOpen, setIsAIChatSidebarOpen] = useLocalStorage('aiChatSidebarOpen', false);

  // Restore state from URL on mount
  useEffect(() => {
    const sharedState = getStateFromURL();

    if (sharedState) {
      console.log('Loading shared query from URL:', sharedState);

      // Convert legacy rules to group structure if needed
      if (sharedState.rules && Array.isArray(sharedState.rules)) {
        const group = convertLegacyRulesToGroup(sharedState.rules, sharedState.logic || 'AND');
        // Intentional mount-only restore of shared query state from the URL
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setRootGroup(group);
      } else if (sharedState.rootGroup) {
        setRootGroup(sharedState.rootGroup);
      }

      // Restore sort fields if available
      if (sharedState.sortFields) {
        setSortFields(sharedState.sortFields);
      }

      // Clear URL parameter after loading
      clearURLState();
    }
  }, []);

  // Start cloud sync on app mount (stays connected across all pages).
  useEffect(() => {
    startCloudSync();

    return () => {
      // Stop cloud sync when app unmounts
      stopCloudSync();
    };
  }, []);

  // Working Offline / Back Online, once for the app (not per page, so a page
  // switch never loses one); the standalone search window stays quiet - the
  // main window already says it.
  useConnectionNotices(addNotification, !standalone);

  // Listen for menu navigation from Electron
  useEffect(() => {
    if (window.electronAPI && window.electronAPI.onNavigateToPage) {
      window.electronAPI.onNavigateToPage((page) => {
        setCurrentPage(page);
      });
    }
  }, []);

  // Listen for document mentions from chat (auto-navigate to documents page)
  useEffect(() => {
    function handleOpenDocument(event) {
      const { documentId } = event.detail;
      // Switch to documents page first
      setCurrentPage('documents');
      // Set the selected document (will be opened by DocumentsPage)
      setSelectedDocumentId(documentId);
    }

    window.addEventListener('openDocument', handleOpenDocument);
    return () => window.removeEventListener('openDocument', handleOpenDocument);
  }, []);

  // Listen for board mentions from chat (auto-navigate to kanban page)
  useEffect(() => {
    function handleOpenBoard() {
      // Switch to kanban page - KanbanPage will handle the board opening
      setCurrentPage('kanban');
      // The boardId will be handled by KanbanPage's own event listener
    }

    window.addEventListener('openBoard', handleOpenBoard);
    return () => window.removeEventListener('openBoard', handleOpenBoard);
  }, []);

  // Save JQL builder session to localStorage
  useEffect(() => {

    // Only save when on search page
    if (currentPage === 'search') {
      const session = {
        rootGroup,
        selectedProject,
        sortFields,
        activeTemplateId,
        activeTemplateName,
        timestamp: Date.now()
      };
      console.log('[JQLBuilder] Saving session:', session);
      localStorage.setItem('jacarium-session', JSON.stringify(session));
    }
  }, [rootGroup, selectedProject, sortFields, activeTemplateId, activeTemplateName, currentPage]);

  // Listen for chat sidebar toggle
  useEffect(() => {
    function handleToggleChatSidebar() {
      setIsChatSidebarOpen(prev => {
        const newState = !prev;
        // If opening chat, close notification and draft sidebars
        if (newState) {
          setIsNotificationSidebarOpen(false);
          setIsDraftSidebarOpen(false);
          setIsAIChatSidebarOpen(false);
        }
        return newState;
      });
    }

    function handleChatSidebarStateChange(event) {
      setIsChatSidebarOpen(event.detail.isOpen);
    }

    window.addEventListener('toggleChatSidebar', handleToggleChatSidebar);
    window.addEventListener('chatSidebarStateChange', handleChatSidebarStateChange);

    return () => {
      window.removeEventListener('toggleChatSidebar', handleToggleChatSidebar);
      window.removeEventListener('chatSidebarStateChange', handleChatSidebarStateChange);
    };
  }, [setIsChatSidebarOpen, setIsNotificationSidebarOpen, setIsDraftSidebarOpen, setIsAIChatSidebarOpen]);

  // Listen for notification sidebar toggle
  useEffect(() => {
    function handleToggleNotificationSidebar() {
      setIsNotificationSidebarOpen(prev => {
        const newState = !prev;
        // If opening notification, close chat and draft sidebars
        if (newState) {
          setIsChatSidebarOpen(false);
          setIsDraftSidebarOpen(false);
          setIsAIChatSidebarOpen(false);
        }
        return newState;
      });
    }

    function handleNotificationSidebarStateChange(event) {
      setIsNotificationSidebarOpen(event.detail.isOpen);
    }

    window.addEventListener('toggleNotificationSidebar', handleToggleNotificationSidebar);
    window.addEventListener('notificationSidebarStateChange', handleNotificationSidebarStateChange);

    return () => {
      window.removeEventListener('toggleNotificationSidebar', handleToggleNotificationSidebar);
      window.removeEventListener('notificationSidebarStateChange', handleNotificationSidebarStateChange);
    };
  }, [setIsChatSidebarOpen, setIsNotificationSidebarOpen, setIsDraftSidebarOpen, setIsAIChatSidebarOpen]);

  // Listen for draft sidebar toggle
  useEffect(() => {
    function handleToggleDraftSidebar() {
      setIsDraftSidebarOpen(prev => {
        const newState = !prev;
        // If opening draft, close chat and notification sidebars
        if (newState) {
          setIsChatSidebarOpen(false);
          setIsNotificationSidebarOpen(false);
          setIsAIChatSidebarOpen(false);
        }
        return newState;
      });
    }

    function handleDraftSidebarStateChange(event) {
      setIsDraftSidebarOpen(event.detail.isOpen);
    }

    window.addEventListener('toggleDraftSidebar', handleToggleDraftSidebar);
    window.addEventListener('draftSidebarStateChange', handleDraftSidebarStateChange);

    return () => {
      window.removeEventListener('toggleDraftSidebar', handleToggleDraftSidebar);
      window.removeEventListener('draftSidebarStateChange', handleDraftSidebarStateChange);
    };
  }, [setIsChatSidebarOpen, setIsNotificationSidebarOpen, setIsDraftSidebarOpen, setIsAIChatSidebarOpen]);

  // Listen for AI chat sidebar toggle
  useEffect(() => {
    function handleToggleAIChatSidebar() {
      setIsAIChatSidebarOpen(prev => {
        const newState = !prev;
        // If opening AI chat, close other sidebars
        if (newState) {
          setIsChatSidebarOpen(false);
          setIsNotificationSidebarOpen(false);
          setIsDraftSidebarOpen(false);
        }
        return newState;
      });
    }

    function handleAIChatSidebarStateChange(event) {
      const newState = event.detail.isOpen;
      setIsAIChatSidebarOpen(newState);
      // If opening AI chat, close other sidebars (same behavior as clicking the icon)
      if (newState) {
        setIsChatSidebarOpen(false);
        setIsNotificationSidebarOpen(false);
        setIsDraftSidebarOpen(false);
      }
    }

    window.addEventListener('toggleAIChatSidebar', handleToggleAIChatSidebar);
    window.addEventListener('aiChatSidebarStateChange', handleAIChatSidebarStateChange);

    return () => {
      window.removeEventListener('toggleAIChatSidebar', handleToggleAIChatSidebar);
      window.removeEventListener('aiChatSidebarStateChange', handleAIChatSidebarStateChange);
    };
  }, [setIsChatSidebarOpen, setIsNotificationSidebarOpen, setIsDraftSidebarOpen, setIsAIChatSidebarOpen]);

  // Dispatch chat sidebar state change for compact sidebar button
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('chatSidebarStateChange', {
      detail: { isOpen: isChatSidebarOpen }
    }));
  }, [isChatSidebarOpen]);

  // Dispatch notification sidebar state change for compact sidebar button
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('notificationSidebarStateChange', {
      detail: { isOpen: isNotificationSidebarOpen }
    }));
  }, [isNotificationSidebarOpen]);

  // Dispatch draft sidebar state change for compact sidebar button
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('draftSidebarStateChange', {
      detail: { isOpen: isDraftSidebarOpen }
    }));
  }, [isDraftSidebarOpen]);

  // Dispatch AI chat sidebar state change for compact sidebar button
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('aiChatSidebarStateChange', {
      detail: { isOpen: isAIChatSidebarOpen }
    }));
  }, [isAIChatSidebarOpen]);

  // Load cached data on mount, fetch if empty (one-time setup)
  useEffect(() => {
    async function initializeData() {
      // nothing Jira-related runs until a site and a token are configured
      const configured = await isJiraConfigured();
      setJiraConfigured(configured);
      if (!configured) {
        setJiraFields(createJiraFields({}, await getCustomFields()));
        return;
      }
      const cachedData = await getCachedJiraData();
      const customFields = await getCustomFields();

      // Check if we have any cached data
      const hasData = cachedData.statuses.length > 0 ||
                      cachedData.issueTypes.length > 0 ||
                      cachedData.priorities.length > 0;

      console.log('[JQLBuilder] Initial load - has cached data:', hasData);
      console.log('[JQLBuilder] Cached data summary:', {
        projects: cachedData.projects.length,
        statuses: cachedData.statuses.length,
        issueTypes: cachedData.issueTypes.length,
        priorities: cachedData.priorities.length,
        resolutions: cachedData.resolutions.length,
      });

      if (hasData) {
        // Use cached data instantly
        const fieldsWithData = createJiraFields(cachedData, customFields);
        setJiraFields(fieldsWithData);

        // Set project options if we have cached projects
        if (cachedData.projects.length > 0) {
          const mappedOptions = cachedData.projects.map(p => ({
            value: p.name,
            label: `${p.name} (${p.key})`
          }));
          console.log('[JQLBuilder] Setting project options from cache:', mappedOptions.length, 'projects');
          console.log('[JQLBuilder] First 3 project options:', mappedOptions.slice(0, 3));
          setProjectOptions(mappedOptions);
        } else {
          console.warn('[JQLBuilder] Cached projects array is empty!');
        }
      } else {
        // First time load - fetch essential data
        console.log('[JQLBuilder] No cached data, fetching fresh data...');
        try {
          setLoading(true);
          const freshData = await fetchAllJiraData(false);
          console.log('[JQLBuilder] Fresh data received:', {
            projects: freshData.projects?.length || 0,
            statuses: freshData.statuses?.length || 0,
            issueTypes: freshData.issueTypes?.length || 0,
          });

          const customFieldsForFresh = await getCustomFields();
          const fieldsWithData = createJiraFields(freshData, customFieldsForFresh);
          setJiraFields(fieldsWithData);

          const mappedOptions = freshData.projects.map(p => ({
            value: p.name,
            label: `${p.name} (${p.key})`
          }));
          console.log('[JQLBuilder] Setting project options from fresh data:', mappedOptions.length, 'projects');
          console.log('[JQLBuilder] First 3 project options:', mappedOptions.slice(0, 3));
          setProjectOptions(mappedOptions);
        } catch (err) {
          if (err?.code === JIRA_NOT_CONFIGURED) { setJiraConfigured(false); setJiraFields(createJiraFields({}, customFields)); return; }
          console.error('[JQLBuilder] Failed to load initial Jira data:', err);
          console.error('[JQLBuilder] Error stack:', err.stack);
          setError(err.message);
          // Still set fields structure even on error
          setJiraFields(createJiraFields({}, customFields));
        } finally {
          setLoading(false);
        }
      }
    }

    initializeData();
  }, []);

  // Listen for cooldown changes
  useEffect(() => {
    const unsubscribe = onCooldownChange((remaining) => {
      setCooldown(remaining);
    });

    // Check initial cooldown state
    if (isInCooldown()) {
      // Intentional sync with the external cooldown tracker on subscribe
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCooldown(getCooldownRemaining());
    }

    return unsubscribe;
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e) {
      // Cmd/Ctrl + K = Open Command Palette (global)
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(true);
      }
      // Cmd/Ctrl + Enter = Open in Jira (only on search page)
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        if (currentPage === 'search') {
          e.preventDefault();
          if (jql) {
            openInJira();
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // openInJira is recreated per render and reads jql (already a dep)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jql, currentPage]);

  // Monitor rootGroup for project selection and fetch metadata
  useEffect(() => {
    console.log('[useEffect:rootGroup] Triggered. selectedProject:', selectedProject);

    // Find the first rule with a project value (search recursively)
    const allRules = convertGroupToLegacyRules(rootGroup);
    const projectRule = allRules.find(rule => rule.field === 'project' && rule.value);

    console.log('[useEffect:rootGroup] Found projectRule:', projectRule?.value || 'none');

    if (projectRule && projectRule.value !== selectedProject) {
      console.log('[useEffect:rootGroup] Project changed from', selectedProject, 'to', projectRule.value);
      // Guarded sync of the derived project selection (only fires when the
      // project actually changed, so no cascade)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedProject(projectRule.value);

      // Validate project before fetching metadata
      async function loadProjectMetadata() {
        // Find the project key from the project name
        const cachedData = await getCachedJiraData();
        const project = cachedData.projects.find(p => p.name === projectRule.value);
        const projectKey = project ? project.key : projectRule.value;

        console.log('Project selected:', {
          value: projectRule.value,
          foundProject: project,
          key: projectKey
        });

        setLoadingMetadata(true);

        // Validate - pass the name or key we have
        console.log(`Validating project: "${projectRule.value}"`);
        const validation = await validateProject(projectRule.value);

        console.log('Validation result:', validation);

        if (!validation.valid) {
          console.error(`Project "${projectRule.value}" is not valid:`, validation.error);
          setInvalidProject({
            name: projectRule.value,
            key: validation.project?.key || projectRule.value,
            error: validation.error,
          });
          markProjectAsInvalid(projectRule.value);

          // Show suggestions if available
          if (validation.suggestions && validation.suggestions.length > 0) {
            console.log('Found alternative projects:', validation.suggestions);
            setSuggestedProjects(validation.suggestions);
          }

          setLoadingMetadata(false);
          return;
        }

        // Project is valid - use the validated project's key for metadata
        const validatedProjectKey = validation.project ? validation.project.key : projectKey;
        console.log('Project is valid, using key for metadata:', validatedProjectKey);
        setInvalidProject(null);
        setSuggestedProjects([]);
        setLoadingMetadata(true);
        try {
          console.log(`[JQLBuilder] Calling fetchProjectMetadata for: ${validatedProjectKey}`);
          const metadata = await fetchProjectMetadata(validatedProjectKey);
          console.log(`[JQLBuilder] Received metadata:`, metadata);
          setProjectMetadata(metadata);

          if (metadata) {
            console.log(`[JQLBuilder] Metadata has ${metadata.statuses?.length || 0} statuses`);
            // Update jiraFields with project-specific data
            const cachedData = await getCachedJiraData();
            const customFields = await getCustomFields();
            const contextualData = {
              ...cachedData,
              statuses: metadata.statuses,
              issueTypes: metadata.issueTypes,
            };

            console.log('[JQLBuilder] Updating fields with project-specific data:', {
              statuses: contextualData.statuses?.length || 0,
              issueTypes: contextualData.issueTypes?.length || 0,
            });
            const fieldsWithData = createJiraFields(contextualData, customFields);
            console.log('[JQLBuilder] Created fields, status field options:',
              fieldsWithData.find(f => f.id === 'status')?.options?.length || 0);
            setJiraFields(fieldsWithData);
          } else {
            console.log(`[JQLBuilder] No metadata returned for ${validatedProjectKey}`);
          }
        } catch (err) {
          // Silently fail - project metadata is optional
          // Just continue using global issue types and statuses
          console.error(`[JQLBuilder] Error fetching metadata for ${projectKey}:`, err);
          console.log(`[JQLBuilder] Project metadata not available for ${projectKey}, using global data`);
          setProjectMetadata(null);
        } finally {
          setLoadingMetadata(false);
        }
      }

      loadProjectMetadata();
    } else if (!projectRule && selectedProject) {
      // Project was deselected, revert to global data
      async function revertToGlobalData() {
        console.log('Project deselected, reverting to global data');
        setSelectedProject(null);
        setProjectMetadata(null);
        setInvalidProject(null);
        setSuggestedProjects([]);

        const cachedData = await getCachedJiraData();
        const customFields = await getCustomFields();
        const fieldsWithData = createJiraFields(cachedData, customFields);
        setJiraFields(fieldsWithData);
      }
      revertToGlobalData();
    } else {
      console.log('[useEffect:rootGroup] No action needed. projectRule:', !!projectRule, 'selectedProject:', selectedProject);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootGroup]); // Only depend on rootGroup, not selectedProject

  // Update JQL whenever rootGroup, sort fields, or custom fields change
  useEffect(() => {
    async function updateJQL() {
      const cachedData = await getCachedJiraData();
      const customFields = await getCustomFields();
      const generatedJQL = generateJQL(rootGroup, null, sortFields, cachedData.projects, customFields);
      setJql(generatedJQL);
    }
    updateJQL();
  }, [rootGroup, sortFields, customFieldsVersion]);

  // Load categories on mount and when templates change
  useEffect(() => {
    async function loadCategories() {
      const cats = await getCategories();
      setCategories(cats);
    }
    loadCategories();
  }, [templateRefreshKey]);

  // Load active template name when activeTemplateId changes
  useEffect(() => {
    async function loadTemplateName() {
      if (activeTemplateId) {
        const template = await getTemplateById(activeTemplateId);
        setActiveTemplateName(template?.name || '');
      } else {
        setActiveTemplateName('');
      }
    }
    loadTemplateName();
  }, [activeTemplateId]);

  function createEmptySortField() {
    return {
      id: Date.now() + Math.random(),
      field: '',
      order: 'DESC',
    };
  }

  function addSortField() {
    setSortFields([...sortFields, createEmptySortField()]);
  }

  function removeSortField(id) {
    setSortFields(sortFields.filter(sf => sf.id !== id));
  }

  function updateSortField(id, updates) {
    setSortFields(sortFields.map(sf =>
      sf.id === id ? { ...sf, ...updates } : sf
    ));
  }

  function handleAddRule(groupId, connector = 'AND') {
    const updated = addRuleToGroup(rootGroup, groupId, null, connector);
    setRootGroup(updated);
  }

  function handleAddGroup(parentGroupId, connector = 'AND') {
    const updated = addGroupToGroup(rootGroup, parentGroupId, connector);
    setRootGroup(updated);
  }

  function handleRemoveItem(id) {
    const updated = removeItemFromGroup(rootGroup, id);
    setRootGroup(updated);
  }

  function handleUpdateRule(id, updates) {
    const updated = updateRuleInGroup(rootGroup, id, updates);
    setRootGroup(updated);
  }

  function handleUpdateConnector(id, connector) {
    const updated = updateItemConnector(rootGroup, id, connector);
    setRootGroup(updated);
  }

  function handleFieldChange(id, fieldId) {
    const field = jiraFields.find(f => f.id === fieldId);
    handleUpdateRule(id, {
      field: fieldId,
      operator: field?.operators[0] || '',
      value: '',
    });
  }

  function handleCopyRule(rule) {
    // Create a deep copy of the rule without the id and connector
    setCopiedRule({
      field: rule.field,
      operator: rule.operator,
      value: rule.value,
    });
  }

  function handlePasteRule(groupId, connector = 'AND') {
    if (!copiedRule) return;

    // Find the parent group to determine connector
    const parent = findItemById(rootGroup, groupId);
    if (!parent || parent.type !== 'group') return;

    // Determine connector: null for first item, otherwise use provided connector
    const itemConnector = parent.children.length === 0 ? null : connector;

    // Create a new rule with copied values and new ID
    const newRule = {
      id: Date.now() + Math.random(),
      type: 'rule',
      field: copiedRule.field,
      operator: copiedRule.operator,
      value: copiedRule.value,
      connector: itemConnector,
    };

    // Add the rule to the group
    const updated = addRuleToGroup(rootGroup, groupId, newRule, connector);
    setRootGroup(updated);
  }

  async function handleForceRefresh() {
    if (!(await isJiraConfigured({ refresh: true }))) { setJiraConfigured(false); return; }
    setJiraConfigured(true);
    console.log('[JQLBuilder] Force refresh initiated');
    try {
      setLoading(true);
      setError(null);

      console.log('[JQLBuilder] Clearing cache...');
      await clearCache();
      await clearInvalidProjects();

      console.log('[JQLBuilder] Fetching fresh data with forceRefresh=true...');
      const dynamicData = await fetchAllJiraData(true);
      console.log('[JQLBuilder] Fresh data received:', {
        projects: dynamicData.projects?.length || 0,
        statuses: dynamicData.statuses?.length || 0,
        issueTypes: dynamicData.issueTypes?.length || 0,
        priorities: dynamicData.priorities?.length || 0,
        resolutions: dynamicData.resolutions?.length || 0,
      });

      const customFields = await getCustomFields();
      const fieldsWithData = createJiraFields(dynamicData, customFields);
      setJiraFields(fieldsWithData);

      const mappedOptions = dynamicData.projects.map(p => ({
        value: p.name,
        label: `${p.name} (${p.key})`,
        isInvalid: false,
      }));
      console.log('[JQLBuilder] Setting project options after refresh:', mappedOptions.length, 'projects');
      console.log('[JQLBuilder] First 3 project options:', mappedOptions.slice(0, 3));
      setProjectOptions(mappedOptions);

      setInvalidProject(null);
      setSuggestedProjects([]);

      console.log('[JQLBuilder] Refresh completed successfully');
    } catch (err) {
      if (err?.code === JIRA_NOT_CONFIGURED) { setJiraConfigured(false); return; }
      console.error('[JQLBuilder] Failed to refresh Jira data:', err);
      console.error('[JQLBuilder] Error stack:', err.stack);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  refreshRef.current = handleForceRefresh;
  useEffect(() => {
    const onSaved = async () => {
      const configured = await isJiraConfigured({ refresh: true });
      setJiraConfigured(configured);
      if (configured) refreshRef.current?.();
    };
    window.addEventListener('settingsSaved', onSaved);
    return () => window.removeEventListener('settingsSaved', onSaved);
  }, []);

  async function handleCustomFieldsChanged() {
    // Reload fields with custom fields included
    const cachedData = await getCachedJiraData();
    const customFields = await getCustomFields();
    const fieldsWithData = createJiraFields(cachedData, customFields);
    setJiraFields(fieldsWithData);

    // Trigger JQL regeneration by incrementing version counter
    setCustomFieldsVersion(prev => prev + 1);
  }

  async function handleImportJQL(group) {
    // Use cached data for import (faster)
    setLoading(true);
    try {
      const data = await fetchAllJiraData(false); // Use cache
      const customFields = await getCustomFields();
      const fieldsWithData = createJiraFields(data, customFields);

      // Now normalize project values with the cached data
      const normalizedGroup = normalizeProjectValues(group, data.projects);

      console.log('Import - Normalized group:', normalizedGroup);
      console.log('Import - Cached projects:', data.projects);

      // Check for unknown custom fields
      const unknownFields = detectUnknownCustomFields(normalizedGroup, fieldsWithData, customFields);

      if (unknownFields.length > 0) {
        // Unknown custom fields detected - show modal
        console.log('Unknown custom fields detected:', unknownFields);
        setPendingImportGroup(normalizedGroup);
        setDetectedCustomFields(unknownFields);
        setCreateCustomFieldsModalOpen(true);
      } else {
        // No unknown fields - proceed with import
        finishImport(normalizedGroup, data, fieldsWithData);
      }
    } catch (err) {
      console.error('Failed to refresh data for import:', err);
      setError('Failed to load project data. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  function finishImport(normalizedGroup, data, fieldsWithData) {
    // Update state with data - use flushSync to ensure synchronous updates
    flushSync(() => {
      setJiraFields(fieldsWithData);
      const newProjectOptions = data.projects.map(p => ({
        value: p.name,
        label: `${p.name} (${p.key})`
      }));
      setProjectOptions(newProjectOptions);
      console.log('Import - Project options:', newProjectOptions);
    });

    // Then update the group and force re-render
    flushSync(() => {
      setRootGroup(normalizedGroup);
      setComboboxKey(prev => prev + 1);
    });
  }

  async function handleCustomFieldsCreated() {
    // Reload fields with new custom fields
    const cachedData = await getCachedJiraData();
    const customFields = await getCustomFields();
    const fieldsWithData = createJiraFields(cachedData, customFields);
    setJiraFields(fieldsWithData);

    // Increment version to trigger JQL regeneration
    setCustomFieldsVersion(prev => prev + 1);

    // Continue with the import
    if (pendingImportGroup) {
      finishImport(pendingImportGroup, cachedData, fieldsWithData);
      setPendingImportGroup(null);
    }
  }

  function detectUnknownCustomFields(group, knownFields, customFields) {
    const unknownFields = new Set();
    const knownFieldIds = new Set(knownFields.map(f => f.id.toLowerCase()));
    const customFieldNames = new Set(customFields.map(f => f.name.toLowerCase()));

    function traverse(item) {
      if (item.type === 'rule' && item.field && item.fieldWasQuoted) {
        // This field was quoted in the original JQL - likely a custom field
        const fieldLower = item.field.toLowerCase();

        // Check if it's not a known standard field and not already in custom fields
        if (!knownFieldIds.has(fieldLower) && !customFieldNames.has(fieldLower)) {
          unknownFields.add(item.field);
        }
      } else if (item.type === 'group' && item.children) {
        item.children.forEach(traverse);
      }
    }

    if (group && group.children) {
      group.children.forEach(traverse);
    }

    return Array.from(unknownFields);
  }

  // Helper to convert project keys to names throughout the group structure
  function normalizeProjectValues(group, projects) {
    if (!group || !group.children) return group;

    const normalized = JSON.parse(JSON.stringify(group)); // Deep clone

    function traverse(item) {
      if (item.type === 'rule' && item.field === 'project' && item.value) {
        console.log('Normalizing project value:', item.value);
        // Try to find by key first, then by name (case-insensitive)
        const byKey = projects.find(p => p.key.toLowerCase() === item.value.toLowerCase());
        const byName = projects.find(p => p.name.toLowerCase() === item.value.toLowerCase());
        const project = byKey || byName;

        if (project) {
          console.log('Found project:', project, 'setting value to:', project.name);
          item.value = project.name;
        } else {
          console.log('Project not found for value:', item.value);
        }
        // If not found, leave the value as-is and let validation handle it
      } else if (item.type === 'group' && item.children) {
        item.children.forEach(traverse);
      }
    }

    normalized.children.forEach(traverse);
    return normalized;
  }

  async function copyToClipboard() {
    if (jql) {
      try {
        await navigator.clipboard.writeText(jql);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        console.error('Failed to copy:', err);
      }
    }
  }

  async function handleSaveTemplate(templateData) {
    const template = {
      ...templateData,
      rootGroup: JSON.parse(JSON.stringify(rootGroup)), // Deep clone
      sortFields: sortFields.map(sf => ({
        id: sf.id,
        field: sf.field,
        order: sf.order,
      })),
    };
    const savedTemplate = await saveTemplate(template);
    setActiveTemplateId(savedTemplate.id); // Set the newly saved template as active
    setTemplateRefreshKey(prev => prev + 1);
  }

  function handleEditTemplate(template) {
    setTemplateToEdit(template);
    setEditTemplateModalOpen(true);
  }

  async function handleSaveEditedTemplate(metadataUpdates) {
    if (!templateToEdit) return;

    // Update only the metadata (name, description, category, icon)
    const updated = await updateTemplate(templateToEdit.id, metadataUpdates);

    if (updated) {
      setTemplateRefreshKey(prev => prev + 1);
      setEditTemplateModalOpen(false);
      setTemplateToEdit(null);
    }
  }

  async function handleShare() {
    const state = {
      rootGroup: JSON.parse(JSON.stringify(rootGroup)), // Deep clone
      sortFields: sortFields.length > 0 ? sortFields : undefined
    };
    const shareData = getShareableURL(state);

    if (shareData) {
      try {
        await navigator.clipboard.writeText(shareData);
        setShareUrlCopied(true);
        setTimeout(() => setShareUrlCopied(false), 2000);
      } catch (err) {
        console.error('Failed to copy to clipboard:', err);
        addNotification({
          type: 'error',
          title: 'Copy Failed',
          message: 'Failed to copy to clipboard.'
        });
      }
    } else {
      addNotification({
        type: 'error',
        title: 'Generation Failed',
        message: 'Failed to generate shareable data.'
      });
    }
  }

  function handleImportShared(encodedState) {
    if (!encodedState || !encodedState.trim()) {
      addNotification({
        type: 'alert',
        title: 'No Data',
        message: 'Please paste a shared query state.'
      });
      return;
    }

    try {
      const state = decodeBuilderState(encodedState.trim());

      if (!state || !state.rootGroup) {
        addNotification({
          type: 'error',
          title: 'Invalid Data',
          message: 'Invalid shared query state.'
        });
        return;
      }

      // Load the imported state
      setRootGroup(state.rootGroup);
      setSortFields(state.sortFields || []);
      setImportQueryModalOpen(false);

      console.log('Imported shared query successfully');
    } catch (err) {
      console.error('Failed to import shared query:', err);
      addNotification({
        type: 'error',
        title: 'Import Failed',
        message: 'Failed to import shared query. Please check the pasted data.'
      });
    }
  }

  function handleTemplateSelect(template) {
    console.log('Loading template:', template.name, template);

    // Extract variables from template
    const groupToLoad = template.rootGroup || (template.rules ? convertLegacyRulesToGroup(template.rules, template.logic || 'AND') : null);
    const sortToLoad = template.sortFields || [];

    const groupVars = groupToLoad ? extractVariablesFromGroup(groupToLoad) : new Set();
    const sortVars = sortToLoad.length > 0 ? extractVariablesFromSortFields(sortToLoad) : new Set();
    const allVars = new Set([...groupVars, ...sortVars]);

    if (allVars.size > 0) {
      // Template has variables - show modal to fill them in
      setPendingTemplate({ ...template, groupToLoad, sortToLoad });
      setTemplateVariables(Array.from(allVars));
      setVariableInputModalOpen(true);
    } else {
      // No variables - load template directly
      applyTemplate(template, groupToLoad, sortToLoad, {});
    }
  }

  async function applyTemplate(template, groupToLoad, sortToLoad, variableValues) {
    console.log('[applyTemplate] Loading template:', template.name);

    // Clear selected project state and metadata cache to force refresh
    setSelectedProject(null);
    setProjectMetadata(null);
    setInvalidProject(null);
    setSuggestedProjects([]);

    // Replace variables if any
    const finalGroup = Object.keys(variableValues).length > 0
      ? replaceVariablesInGroup(groupToLoad, variableValues)
      : groupToLoad;

    const finalSort = Object.keys(variableValues).length > 0 && sortToLoad.length > 0
      ? replaceVariablesInSortFields(sortToLoad, variableValues)
      : sortToLoad;

    // Check if template has a project value
    const allRules = finalGroup ? convertGroupToLegacyRules(finalGroup) : [];
    const projectRule = allRules.find(rule => rule.field === 'project' && rule.value);

    if (projectRule) {
      console.log('[applyTemplate] Template includes project:', projectRule.value);

      // Clear the cached metadata for this project to force a fresh fetch
      const cachedData = await getCachedJiraData();
      const project = cachedData.projects.find(p => p.name === projectRule.value);
      const projectKey = project ? project.key : projectRule.value;

      // Delete cached metadata to force refresh
      const cacheKey = `jira_project_meta_${projectKey}`;
      try {
        await db.cache.where('key').equals(cacheKey).delete();
        console.log('[applyTemplate] Cleared cached metadata for:', projectKey);
      } catch (err) {
        console.warn('[applyTemplate] Could not clear cache:', err);
      }
    }

    // Load group
    if (finalGroup) {
      console.log('[applyTemplate] Setting rootGroup:', finalGroup);
      setRootGroup(JSON.parse(JSON.stringify(finalGroup))); // Deep clone
    }

    // Load sort fields
    if (finalSort && finalSort.length > 0) {
      const templateSortFields = finalSort.map(sf => ({
        ...sf,
        id: Date.now() + Math.random(),
      }));
      setSortFields(templateSortFields);
    } else {
      setSortFields([]);
    }

    setActiveTemplateId(template.id);
    console.log('[applyTemplate] Template loaded, should trigger project useEffect');
  }

  function handleVariableApply(values) {
    if (pendingTemplate) {
      applyTemplate(pendingTemplate, pendingTemplate.groupToLoad, pendingTemplate.sortToLoad, values);
      setPendingTemplate(null);
      setTemplateVariables([]);
    }
  }

  async function handleUpdateTemplate() {
    if (!activeTemplateId) return;

    const updates = {
      rootGroup: JSON.parse(JSON.stringify(rootGroup)), // Deep clone
      sortFields: sortFields.map(sf => ({
        id: sf.id,
        field: sf.field,
        order: sf.order,
      })),
    };

    console.log('Updating template with:', updates);
    const updatedTemplate = await updateTemplate(activeTemplateId, updates);
    console.log('Updated template:', updatedTemplate);
    setTemplateRefreshKey(prev => prev + 1);
  }

  async function openInJira() {
    if (!jql) return;

    let base;
    try {
      base = await getJiraBaseUrl();   // Settings > Integrations > Jira; no default
    } catch (err) {
      setError(err.message);
      return;
    }
    const encodedJQL = encodeURIComponent(jql);
    const jiraUrl = `${base}/issues/?jql=${encodedJQL}`;

    // Use Electron API to open in default browser if available, otherwise fallback to window.open
    if (window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(jiraUrl);
    } else {
      window.open(jiraUrl, '_blank', 'noopener,noreferrer');
    }
  }

  function handlePageChange(page) {
    // Session persistence now handles state - don't clear on navigation
    setCurrentPage(page);
  }

  // Command Palette handlers
  async function handleCommandPaletteLoadDocument(documentId) {
    setSelectedDocumentId(documentId);
    setCurrentPage('documents');
  }

  function handleNewTemplate() {
    // Clear active template and reset to empty builder
    setActiveTemplateId(null);
    setRootGroup(createEmptyGroup('AND'));
    setSortFields([]);
  }

  function handleCommandPaletteLoadTemplate(template) {
    setCurrentPage('search');
    // Use setTimeout to ensure page navigation happens first
    setTimeout(() => {
      handleTemplateSelect(template);
    }, 0);
  }

  function handleCommandPaletteCreateDocument() {
    setCurrentPage('documents');
    setCreateNewDocument(true);
  }

  function handleCommandPaletteLoadEngineTemplate(engineTemplate) {
    setCurrentPage('search');
    setSelectedEngineTemplate(engineTemplate);
  }

  async function handleCommandPaletteRefresh() {
    await handleForceRefresh();
  }

  // The phone layout (src/utils/mobile.js, never in the desktop app): no
  // icon rail, the pages stacked over a bottom navigation bar, the team
  // panels filling the screen when opened from "More" (ForcedDrawerScope,
  // which the desktop ignores), and Settings hosted here since the rail
  // that normally owns it is not rendered.
  return (
    <div className="min-h-screen bg-os-masthead font-text text-os-text-primary">
      <div className={isMobile ? 'sc-mobile-root flex flex-col h-screen overflow-hidden' : 'flex h-screen'}>

        {/* Compact Sidebar - hidden in standalone mode and in the phone layout */}
        {!standalone && !isMobile && (
          <CompactSidebar
            currentPage={currentPage}
            onPageChange={handlePageChange}
          />
        )}

        {/* Chat Sidebar */}
        {isChatSidebarOpen && (
          <ForcedDrawerScope onBack={() => setIsChatSidebarOpen(false)} label="Team Chat">
            <ChatSidebar
              isOpen={isChatSidebarOpen}
              onClose={() => setIsChatSidebarOpen(false)}
            />
          </ForcedDrawerScope>
        )}

        {/* Notification Sidebar */}
        {isNotificationSidebarOpen && (
          <ForcedDrawerScope onBack={() => setIsNotificationSidebarOpen(false)} label="Notifications">
            <NotificationSidebar
              isOpen={isNotificationSidebarOpen}
              onClose={() => setIsNotificationSidebarOpen(false)}
            />
          </ForcedDrawerScope>
        )}

        <ForcedDrawerScope>

        {/* Draft Sidebar */}
        {isDraftSidebarOpen && (
          <DraftSidebar
            isOpen={isDraftSidebarOpen}
            onClose={() => setIsDraftSidebarOpen(false)}
          />
        )}

        {/* AI Chat Sidebar */}
        {isAIChatSidebarOpen && (
          <AIChatSidebar
            isOpen={isAIChatSidebarOpen}
            onClose={() => setIsAIChatSidebarOpen(false)}
          />
        )}
        </ForcedDrawerScope>

        {/* Main Canvas */}
        <Suspense fallback={<PageLoadingFallback />}>
        {currentPage === 'documents' ? (
          <div className="flex-1 bg-os-masthead min-w-0 overflow-hidden">
            <div className="h-full bg-os-canvas overflow-hidden">
              <DocumentsPage
                key="documents-page"
                selectedDocumentId={selectedDocumentId}
                onDocumentOpened={() => setSelectedDocumentId(null)}
                createNewDocument={createNewDocument}
                onDocumentCreated={() => setCreateNewDocument(false)}
                onNavigate={handlePageChange}
              />
            </div>
          </div>
        ) : currentPage === 'calendars' ? (
          <div className="flex-1 bg-os-masthead min-w-0 overflow-hidden">
            <div className="h-full bg-os-canvas overflow-hidden">
              <CalendarsPage />
            </div>
          </div>
        ) : currentPage === 'diagnostics' ? (
          <div className="flex-1 bg-os-masthead min-w-0 overflow-hidden">
            <div className="h-full bg-os-canvas overflow-hidden">
              <DiagnosticsPage onNavigate={handlePageChange} />
            </div>
          </div>
        ) : currentPage === 'workflow' ? (
          <div className="flex-1 bg-os-masthead min-w-0 overflow-hidden">
            <div className="h-full bg-os-canvas overflow-hidden">
              <WorkflowBuilder />
            </div>
          </div>
        ) : currentPage === 'kanban' ? (
          <div className="flex-1 bg-os-masthead min-w-0 overflow-hidden">
            <div className="h-full bg-os-canvas overflow-hidden">
              <KanbanPage />
            </div>
          </div>
        ) : currentPage === 'tasks' ? (
          <div className="flex-1 bg-os-masthead min-w-0 overflow-hidden">
            <div className="h-full bg-os-canvas overflow-hidden">
              <TasksPage />
            </div>
          </div>
        ) : currentPage === 'reports' ? (
          <div className="flex-1 bg-os-masthead min-w-0 overflow-hidden">
            <div className="h-full bg-os-canvas overflow-hidden">
              <TaskReportsPage />
            </div>
          </div>
        ) : currentPage === 'tools' ? (
          <div className="flex-1 bg-os-masthead min-w-0 overflow-hidden">
            <div className="h-full bg-os-canvas overflow-hidden">
              <ToolsPage />
            </div>
          </div>
        ) : currentPage === 'ai-chat' ? (
          <div className="flex-1 bg-os-masthead min-w-0 overflow-hidden">
            <AIChatPage />
          </div>
        ) : (
          <div className="flex-1 bg-os-masthead min-w-0 overflow-hidden">
            <div className="h-full bg-os-canvas overflow-hidden">
              <SearchPage
                onTemplateSelect={handleTemplateSelect}
                onEditTemplate={handleEditTemplate}
                onRefresh={() => setTemplateRefreshKey(prev => prev + 1)}
                onNewTemplate={handleNewTemplate}
                activeTemplateId={activeTemplateId}
                templateRefreshKey={templateRefreshKey}
                jiraStatus={jiraConfigured === false ? 'unconfigured' : error ? 'error' : 'connected'}
                loadingMetadata={loadingMetadata}
                cooldown={cooldown}
                selectedEngineTemplate={selectedEngineTemplate}
                onEngineTemplateProcessed={() => setSelectedEngineTemplate(null)}
              >
                <div className="overflow-auto h-full">
                  <div className="p-6">
                    {/* Page Header */}
                    <h1 className="text-xl font-semibold text-os-text-primary mb-4">
                      {activeTemplateName || 'Search'}
                    </h1>

                    {/* Info Banners */}
                    {invalidProject && (
                      <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm p-3 mb-4">
                        <div className="flex items-start gap-3">
                          <AlertCircle className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" size={20} />
                          <div className="flex-1">
                            <p className="text-sm font-medium text-red-800 dark:text-red-200">Invalid Project</p>
                            <p className="text-xs text-red-700 dark:text-red-300 mt-1">
                              Project "{invalidProject.name}" (Key: {invalidProject.key}) is no longer recognized by Jira.
                              {invalidProject.error && ` Error: ${invalidProject.error}`}
                            </p>
                            {suggestedProjects.length > 0 && (
                              <div className="mt-2">
                                <p className="text-xs text-red-700 dark:text-red-300 font-semibold mb-1.5">Did you mean one of these?</p>
                                <div className="flex flex-wrap gap-2">
                                  {suggestedProjects.slice(0, 3).map(proj => (
                                    <button
                                      key={proj.key}
                                      onClick={() => {
                                        const allRules = convertGroupToLegacyRules(rootGroup);
                                        const projectRule = allRules.find(r => r.field === 'project');
                                        if (projectRule) {
                                          handleUpdateRule(projectRule.id, { value: proj.name });
                                        }
                                      }}
                                      className="px-2 py-1 bg-os-card border border-red-300 dark:border-red-700 text-red-800 dark:text-red-200 text-xs rounded-sm hover:bg-red-100 dark:hover:bg-red-900/20 transition-colors"
                                    >
                                      {proj.name} ({proj.key})
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    {selectedProject && projectMetadata && !invalidProject && (
                      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-sm p-3 mb-4">
                        <div className="flex items-start gap-3">
                          <AlertCircle className="text-os-blue shrink-0 mt-0.5" size={20} />
                          <div className="flex-1">
                            <p className="text-sm font-medium text-blue-800 dark:text-blue-200">Context-Aware Mode</p>
                            <p className="text-xs text-blue-700 dark:text-blue-300 mt-1">
                              Showing only Status and Issue Type options valid for project: <span className="font-mono font-semibold">{selectedProject}</span>
                            </p>
                          </div>
                        </div>
                      </div>
                    )}

                    {jiraConfigured === false && (
                      <IntegrationNotConfigured
                        name="Jira"
                        section="jira"
                        testId="jira-unconfigured"
                        description="Add your Jira URL and API token in Settings > Integrations > Jira to search it from here."
                      />
                    )}
                    {error && jiraConfigured !== false && (
                      <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm p-3 mb-4">
                        <div className="flex items-start gap-3">
                          <AlertCircle className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" size={20} />
                          <div className="flex-1">
                            <p className="text-sm font-medium text-red-800 dark:text-red-200">Connection Error</p>
                            <p className="text-xs text-red-700 dark:text-red-300 mt-1">{error}</p>
                            <p className="text-xs text-red-700 dark:text-red-300 mt-1">
                              {error.includes('cooldown') ?
                                'Please wait for the cooldown to finish.' :
                                'Make sure you\'ve set VITE_JIRA_PAT in your .env file with a valid Personal Access Token.'
                              }
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                      {/* Query Builder Section */}
                      <div className="bg-os-card border border-os-border rounded-sm">
              {/* Action Bar */}
              <div className="p-4 border-b border-os-border bg-os-card-secondary">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide">
                    Query Builder
                  </h2>

                  <div className="flex items-center gap-2 flex-wrap">
                    {activeTemplateId ? (
                      <button
                        onClick={handleUpdateTemplate}
                        disabled={!jql}
                        className="flex items-center gap-2 px-3 py-1.5 bg-os-blue text-white text-sm hover:bg-os-blue-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-xs"
                        title="Update current template"
                      >
                        Update Template
                      </button>
                    ) : (
                      <button
                        onClick={() => setSaveTemplateModalOpen(true)}
                        disabled={!jql}
                        className="flex items-center gap-2 px-3 py-1.5 bg-os-blue text-white text-sm hover:bg-os-blue-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-xs"
                        title="Save current query as template"
                      >
                        Save Template
                      </button>
                    )}

                    <button
                      onClick={handleShare}
                      disabled={!jql}
                      className="flex items-center gap-2 px-3 py-1.5 bg-os-card border border-os-input-border text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      title={window.electronAPI?.isElectron ? "Copy query state (paste in another user's app)" : "Copy shareable link"}
                    >
                      {shareUrlCopied ? (
                        <>
                          <Check size={16} />
                          Copied!
                        </>
                      ) : (
                        <>
                          Share
                        </>
                      )}
                    </button>

                    <button
                      onClick={() => setImportQueryModalOpen(true)}
                      className="flex items-center gap-2 px-3 py-1.5 bg-os-card border border-os-input-border text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors"
                      title="Import a shared query from another user"
                    >
                      Import Shared
                    </button>

                    <button
                      onClick={handleForceRefresh}
                      disabled={loading || cooldown > 0}
                      className="flex items-center gap-2 px-3 py-1.5 bg-os-card border border-os-input-border text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Refresh data from Jira API"
                    >
                      <span className="hidden sm:inline">{loading ? 'Refreshing...' : 'Sync'}</span>
                    </button>

                    <button
                      onClick={() => setCustomFieldsModalOpen(true)}
                      className="flex items-center gap-2 px-3 py-1.5 bg-os-blue text-white text-sm hover:bg-os-blue-hover transition-colors shadow-xs"
                      title="Manage custom fields"
                    >
                      <span className="hidden sm:inline">Fields</span>
                    </button>

                    <button
                      onClick={() => setImportJQLModalOpen(true)}
                      className="flex items-center gap-2 px-3 py-1.5 bg-os-blue text-white text-sm hover:bg-os-blue-hover transition-colors shadow-xs"
                      title="Import JQL query"
                    >
                      <span className="hidden sm:inline">Import</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Group Section */}
              <div className="p-4">
                {loading ? (
                  <div className="flex flex-col items-center justify-center py-12">
                    <Loader2 className="animate-spin text-os-blue mb-3" size={32} />
                    <span className="text-os-text-primary font-text font-semibold text-sm">Fetching data from Jira API...</span>
                    <span className="text-xs text-os-text-secondary mt-2 font-text">This will be cached for 24 hours</span>
                  </div>
                ) : (
                  <GroupRenderer
                    group={rootGroup}
                    onAddRule={handleAddRule}
                    onAddGroup={handleAddGroup}
                    onRemoveItem={handleRemoveItem}
                    onUpdateRule={handleUpdateRule}
                    onUpdateConnector={handleUpdateConnector}
                    onFieldChange={handleFieldChange}
                    onCopyRule={handleCopyRule}
                    onPasteRule={handlePasteRule}
                    copiedRule={copiedRule}
                    jiraFields={jiraFields}
                    projectOptions={projectOptions}
                    comboboxKey={comboboxKey}
                    selectedProject={selectedProject}
                    loadingMetadata={loadingMetadata}
                    loading={loading}
                    depth={0}
                  />
                )}
              </div>
            </div>

            {/* Sort Section */}
            <div className="bg-os-card border border-os-border rounded-sm mt-4 mb-4">
              {/* Header */}
              <div className="p-4 border-b border-os-border bg-os-card-secondary flex items-center justify-between">
                <h2 className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide">
                  Sort Order
                </h2>
                <button
                  onClick={addSortField}
                  className="flex items-center gap-2 px-3 py-1.5 bg-os-blue text-white text-sm hover:bg-os-blue-hover transition-colors shadow-xs"
                >
                  Add Sort Field
                </button>
              </div>

              {/* Sort Fields */}
              <div className="p-4">
                {sortFields.length === 0 ? (
                  <div className="text-center py-8 text-os-text-muted text-sm">
                    No sorting applied. Results will be in default order.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {sortFields.map((sortField) => (
                      <SortFieldRow
                        key={sortField.id}
                        sortField={sortField}
                        onUpdate={updateSortField}
                        onRemove={removeSortField}
                        canRemove={true}
                        jiraFields={jiraFields}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* JQL Output Section */}
            <div className="bg-os-card border border-os-border rounded-sm mt-4">
              {/* Header */}
              <div className="px-4 py-3 border-b border-os-border flex items-center justify-between">
                <h2 className="text-sm font-text font-semibold text-os-text-primary uppercase tracking-wide">
                  JQL Query Output
                </h2>
                <div className="flex items-center gap-2">
                  <button
                    onClick={openInJira}
                    disabled={!jql}
                    className="flex items-center gap-2 px-3 py-1.5 bg-os-blue text-white text-sm hover:bg-os-blue-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Open in Jira (Cmd/Ctrl + Enter)"
                  >
                    Open in Jira
                  </button>
                  <button
                    onClick={copyToClipboard}
                    disabled={!jql}
                    className="flex items-center gap-2 px-3 py-1.5 bg-os-card border border-os-input-border text-os-text-primary text-sm hover:bg-os-card-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {copied ? (
                      <>
                        <Check size={16} />
                        Copied!
                      </>
                    ) : (
                      <>
                        Copy JQL
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Terminal-style output with syntax highlighting */}
              <div className="p-4">
                <div className="bg-rh-terminal border border-os-input-border p-4 rounded-sm">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-status-danger"></div>
                    <div className="w-2.5 h-2.5 rounded-full bg-status-warning"></div>
                    <div className="w-2.5 h-2.5 rounded-full bg-status-success"></div>
                    <span className="text-xs text-os-text-muted ml-2 font-mono">jql-editor</span>
                  </div>
                  <div className="min-h-[80px] flex items-center">
                    <code className="text-sm text-white font-mono break-all leading-relaxed">
                      <span className="text-os-text-muted">$</span>{' '}
                      <HighlightedJQL jql={jql} />
                    </code>
                  </div>
                </div>
                {jql && (
                  <div className="mt-2 flex items-center justify-between">
                    {/\b[A-Z]\b/.test(jql) && (
                      <div className="text-xs text-os-blue font-mono italic">
                        A, B, C are placeholders for incomplete rules
                      </div>
                    )}
                    <div className={`text-xs text-os-text-secondary font-mono ${/\b[A-Z]\b/.test(jql) ?'':'ml-auto'}`}>
                      Press <kbd className="px-2 py-0.5 bg-os-divider border border-os-border rounded-sm text-os-text-primary">Cmd</kbd> + <kbd className="px-2 py-0.5 bg-os-divider border border-os-border rounded-sm text-os-text-primary">Enter</kbd> to open in Jira
                    </div>
                  </div>
                )}
              </div>
            </div>
                  </div>
                </div>
              </SearchPage>
            </div>
          </div>
        )}
        </Suspense>

        {/* The phone layout's bottom bar, its "More" sheet and Settings host */}
        {isMobile && !standalone && (
          <>
            <MobileBottomNav currentPage={currentPage} onPageChange={handlePageChange} panel={isChatSidebarOpen ? 'Team Chat' : isNotificationSidebarOpen ? 'Notifications' : null} />
            <MoreSheet currentPage={currentPage} onPageChange={handlePageChange} />
            <MobileSettingsHost />
            <MobileMenuChrome />
          </>
        )}
      </div>

      {/* Save Template Modal */}
      <SaveTemplateModal
        isOpen={saveTemplateModalOpen}
        onClose={() => setSaveTemplateModalOpen(false)}
        onSave={handleSaveTemplate}
        currentJQL={jql}
        rootGroup={rootGroup}
        sortFields={sortFields}
        existingCategories={categories}
      />

      {/* Edit Template Modal */}
      <EditTemplateModal
        isOpen={editTemplateModalOpen}
        onClose={() => {
          setEditTemplateModalOpen(false);
          setTemplateToEdit(null);
        }}
        onSave={handleSaveEditedTemplate}
        template={templateToEdit}
        existingCategories={categories}
      />

      {/* Custom Fields Modal */}
      <CustomFieldsModal
        isOpen={customFieldsModalOpen}
        onClose={() => setCustomFieldsModalOpen(false)}
        onFieldsChanged={handleCustomFieldsChanged}
      />

      {/* Import JQL Modal */}
      <ImportJQLModal
        isOpen={importJQLModalOpen}
        onClose={() => setImportJQLModalOpen(false)}
        onImport={handleImportJQL}
      />

      {/* Import Shared Query Modal */}
      {importQueryModalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-os-modal rounded-lg shadow-xl w-full max-w-md mx-4">
            <div className="p-4 border-b border-os-border">
              <h3 className="text-lg font-semibold text-os-text-primary">Import Shared Query</h3>
            </div>
            <div className="p-4">
              <p className="text-sm text-os-text-secondary mb-3">
                Paste the query state shared by another user:
              </p>
              <textarea
                id="import-shared-input"
                placeholder="Paste shared query state here..."
                className="w-full h-32 px-3 py-2 border border-os-input-border focus:outline-hidden focus:ring-2 focus:ring-blue-500 font-mono text-sm bg-os-input-bg text-os-text-primary"
                autoFocus
              />
            </div>
            <div className="p-4 border-t border-os-border flex justify-end gap-2">
              <button
                onClick={() => setImportQueryModalOpen(false)}
                className="px-4 py-2 text-sm text-os-text-primary bg-os-card border border-os-input-border hover:bg-os-card-secondary"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const input = document.getElementById('import-shared-input');
                  handleImportShared(input.value);
                }}
                className="px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-700"
              >
                Import
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Variable Input Modal */}
      <VariableInputModal
        isOpen={variableInputModalOpen}
        onClose={() => {
          setVariableInputModalOpen(false);
          setPendingTemplate(null);
          setTemplateVariables([]);
        }}
        onApply={handleVariableApply}
        variables={templateVariables}
        templateName={pendingTemplate?.name}
      />

      {/* Create Custom Fields Modal */}
      <CreateCustomFieldsModal
        isOpen={createCustomFieldsModalOpen}
        onClose={() => {
          setCreateCustomFieldsModalOpen(false);
          setDetectedCustomFields([]);
          setPendingImportGroup(null);
        }}
        onFieldsCreated={handleCustomFieldsCreated}
        detectedFields={detectedCustomFields}
      />

      {/* Command Palette */}
      <CommandPalette
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onNavigate={handlePageChange}
        onRefreshJira={handleCommandPaletteRefresh}
        onLoadDocument={handleCommandPaletteLoadDocument}
        onLoadTemplate={handleCommandPaletteLoadTemplate}
        onCreateDocument={handleCommandPaletteCreateDocument}
        onLoadEngineTemplate={handleCommandPaletteLoadEngineTemplate}
      />

      {/* Floating Quiz */}
      <FloatingQuiz />
    </div>
  );
}

function RuleRow({ rule, onUpdate, onRemove, onCopyRule, onFieldChange, canRemove, jiraFields, projectOptions, selectedProject, loadingMetadata, comboboxKey, loading }) {
  const selectedField = jiraFields.find(f => f.id === rule.field);
  const operatorNeedsValue = !['IS EMPTY', 'IS NOT EMPTY', 'CHANGED'].includes(rule.operator);
  const isMultiValue = ['IN', 'NOT IN', 'WAS IN', 'WAS NOT IN'].includes(rule.operator);

  // Check if this field is context-aware
  const isContextAware = selectedProject && (rule.field === 'status' || rule.field === 'type');

  return (
    <div className="flex items-start gap-3 p-3 bg-os-card-secondary border-l-2 border-os-blue">
      <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <label className="block text-xs font-text text-os-text-primary mb-1 uppercase tracking-wide">
            Field
          </label>
          <select
            value={rule.field}
            onChange={(e) => onFieldChange(rule.id, e.target.value)}
            className="w-full px-3 py-2 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm font-text bg-os-input-bg text-os-text-primary"
          >
            <option value="">Select field...</option>
            {jiraFields.map(field => (
              <option key={field.id} value={field.id}>
                {field.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-text text-os-text-primary mb-1 uppercase tracking-wide">
            Operator
          </label>
          <select
            value={rule.operator}
            onChange={(e) => onUpdate(rule.id, { operator: e.target.value })}
            disabled={!rule.field}
            className="w-full px-3 py-2 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm font-text bg-os-card text-os-text-primary disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="">Select operator...</option>
            {selectedField?.operators.map(op => (
              <option key={op} value={op}>{op}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-text text-os-text-primary mb-1 uppercase tracking-wide">
            Value
            {isContextAware && (
              <span className="ml-2 text-os-blue text-xs font-medium">
                (Project-specific)
              </span>
            )}
          </label>
          {rule.field === 'project' ? (
            <SearchableCombobox
              key={comboboxKey}
              value={rule.value}
              onChange={(value) => onUpdate(rule.id, { value })}
              options={projectOptions}
              placeholder="Search projects..."
              disabled={!operatorNeedsValue}
              loading={loading}
            />
          ) : isMultiValue && selectedField?.type === 'select' && selectedField?.options ? (
            <MultiValueInput
              values={rule.value}
              onChange={(value) => onUpdate(rule.id, { value })}
              options={selectedField.options}
              placeholder="Select values..."
            />
          ) : selectedField?.type === 'select' && selectedField?.options ? (
            <select
              value={rule.value}
              onChange={(e) => onUpdate(rule.id, { value: e.target.value })}
              disabled={!operatorNeedsValue || (isContextAware && loadingMetadata)}
              className="w-full px-3 py-2 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm font-text bg-os-card text-os-text-primary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="">
                {isContextAware && loadingMetadata ? 'Loading project options...' : 'Select value...'}
              </option>
              {selectedField.options.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : isMultiValue ? (
            <MultiValueInput
              values={rule.value}
              onChange={(value) => onUpdate(rule.id, { value })}
              placeholder="Type and press Enter to add values..."
            />
          ) : (
            <input
              type={selectedField?.type === 'date' ? 'text' : 'text'}
              value={rule.value}
              onChange={(e) => onUpdate(rule.id, { value: e.target.value })}
              disabled={!operatorNeedsValue}
              placeholder={
                selectedField?.type === 'date'
                  ? 'e.g., 2024-01-01, -7d, startOfWeek()'
                  : 'Enter value...'
              }
              className="w-full px-3 py-2 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm font-text bg-os-card text-os-text-primary placeholder:text-os-text-muted disabled:opacity-50 disabled:cursor-not-allowed"
            />
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 mt-6">
        <button
          onClick={() => onCopyRule(rule)}
          className="p-2 text-os-blue hover:bg-os-card-secondary transition-colors"
          title="Copy rule"
        >
          <Copy size={16} />
        </button>
        <button
          onClick={() => onRemove(rule.id)}
          disabled={!canRemove}
          className="p-2 text-status-danger hover:bg-red-50 dark:bg-red-900/20 dark:hover:bg-red-900/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          title="Remove rule"
        >
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}

function SortFieldRow({ sortField, onUpdate, onRemove, canRemove }) {
  // Sortable fields - most common fields used for sorting
  const sortableFields = [
    { id: 'created', name: 'Created' },
    { id: 'updated', name: 'Updated' },
    { id: 'priority', name: 'Priority' },
    { id: 'status', name: 'Status' },
    { id: 'assignee', name: 'Assignee' },
    { id: 'reporter', name: 'Reporter' },
    { id: 'key', name: 'Issue Key' },
    { id: 'summary', name: 'Summary' },
    { id: 'duedate', name: 'Due Date' },
    { id: 'resolved', name: 'Resolved' },
  ];

  return (
    <div className="flex items-start gap-3 p-3 bg-os-card-secondary border-l-2 border-os-blue">
      <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-text text-os-text-primary mb-1 uppercase tracking-wide">
            Sort By
          </label>
          <select
            value={sortField.field}
            onChange={(e) => onUpdate(sortField.id, { field: e.target.value })}
            className="w-full px-3 py-2 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm font-text bg-os-input-bg text-os-text-primary"
          >
            <option value="">Select field...</option>
            {sortableFields.map(field => (
              <option key={field.id} value={field.id}>
                {field.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-text text-os-text-primary mb-1 uppercase tracking-wide">
            Order
          </label>
          <select
            value={sortField.order}
            onChange={(e) => onUpdate(sortField.id, { order: e.target.value })}
            disabled={!sortField.field}
            className="w-full px-3 py-2 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-sm font-text bg-os-card text-os-text-primary disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="DESC">Descending (Newest First)</option>
            <option value="ASC">Ascending (Oldest First)</option>
          </select>
        </div>
      </div>

      <button
        onClick={() => onRemove(sortField.id)}
        disabled={!canRemove}
        className="mt-6 p-2 text-status-danger hover:bg-red-50 dark:bg-red-900/20 dark:hover:bg-red-900/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
        title="Remove sort field"
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}

function GroupRenderer({
  group,
  onAddRule,
  onAddGroup,
  onRemoveItem,
  onUpdateRule,
  onUpdateConnector,
  onFieldChange,
  onCopyRule,
  onPasteRule,
  copiedRule,
  jiraFields,
  projectOptions,
  selectedProject,
  loadingMetadata,
  comboboxKey,
  loading,
  depth = 0,
}) {
  const isRootGroup = depth === 0;

  // Dynamic margin-left based on depth
  const marginStyle = isRootGroup ? {} : { marginLeft: `${depth * 1.5}rem`, marginTop: '0.75rem' };

  return (
    <div
      className="border border-os-border rounded-lg"
      style={marginStyle}
    >
      {/* Group Header */}
      <div className="p-3 bg-os-card-secondary border-b border-os-border flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xs font-text font-semibold text-os-text-primary uppercase tracking-wide">
            {isRootGroup ? 'Main Query' : 'Group'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => onAddRule(group.id, 'AND')}
            className="flex items-center gap-1 px-2 py-1 bg-os-blue text-white text-xs hover:bg-os-blue-hover transition-colors rounded-sm shadow-xs"
            title="Add rule to this group"
          >
            Rule
          </button>
          <button
            onClick={() => onAddGroup(group.id, 'AND')}
            className="flex items-center gap-1 px-2 py-1 bg-os-card border border-os-input-border text-os-text-primary text-xs hover:bg-os-card-secondary transition-colors rounded-sm shadow-xs"
            title="Add sub-group"
          >
            Group
          </button>
          <button
            onClick={() => onPasteRule(group.id, 'AND')}
            disabled={!copiedRule}
            className="flex items-center gap-1 px-2 py-1 bg-os-blue text-white text-xs hover:bg-os-blue-hover transition-colors rounded-sm shadow-xs disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-os-blue"
            title={copiedRule ? "Paste copied rule" : "No rule copied"}
          >
            Rule from Clipboard
          </button>
          {!isRootGroup && (
            <button
              onClick={() => onRemoveItem(group.id)}
              className="p-1.5 text-status-danger hover:bg-red-100 dark:hover:bg-red-900/20 transition-colors rounded-sm"
              title="Remove this group"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Group Children */}
      <div className="p-3 space-y-3">
        {group.children && group.children.length > 0 ? (
          group.children.map((child, index) => (
            <div key={child.id}>
              {/* Connector selector for items after the first */}
              {index > 0 && (
                <div className="flex items-center justify-center py-2">
                  <select
                    value={child.connector || 'AND'}
                    onChange={(e) => onUpdateConnector(child.id, e.target.value)}
                    className="px-3 py-1 border border-os-input-border focus:ring-2 focus:ring-os-blue focus:border-os-blue outline-hidden text-xs font-text bg-os-card text-os-text-primary rounded-sm"
                  >
                    <option value="AND">AND</option>
                    <option value="OR">OR</option>
                  </select>
                </div>
              )}

              {child.type === 'rule' ? (
                <RuleRow
                  rule={child}
                  onUpdate={onUpdateRule}
                  onRemove={onRemoveItem}
                  onCopyRule={onCopyRule}
                  onFieldChange={onFieldChange}
                  canRemove={true}
                  jiraFields={jiraFields}
                  projectOptions={projectOptions}
                  selectedProject={selectedProject}
                  loadingMetadata={loadingMetadata}
                  comboboxKey={comboboxKey}
                  loading={loading}
                />
              ) : (
                <GroupRenderer
                  group={child}
                  onAddRule={onAddRule}
                  onAddGroup={onAddGroup}
                  onRemoveItem={onRemoveItem}
                  onUpdateRule={onUpdateRule}
                  onUpdateConnector={onUpdateConnector}
                  onFieldChange={onFieldChange}
                  onCopyRule={onCopyRule}
                  onPasteRule={onPasteRule}
                  copiedRule={copiedRule}
                  jiraFields={jiraFields}
                  projectOptions={projectOptions}
                  selectedProject={selectedProject}
                  loadingMetadata={loadingMetadata}
                  comboboxKey={comboboxKey}
                  loading={loading}
                  depth={depth + 1}
                />
              )}
            </div>
          ))
        ) : (
          <div className="text-center text-os-text-muted text-sm py-4">
            Empty group - add a rule or sub-group
          </div>
        )}
      </div>
    </div>
  );
}
