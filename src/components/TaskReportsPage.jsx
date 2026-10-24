import React, { useState, useEffect } from 'react';
import { FileText, Edit2, Trash2, RefreshCw, Filter, X, ChevronDown, ChevronRight } from 'lucide-react';
import { useNotifications } from '../contexts/NotificationContext';
import ConfirmationModal from './common/modals/ConfirmationModal';
import { useConfirmation } from '../hooks/useConfirmation';
import {
  getActiveInstance,
  getInstanceReports,
  createReport,
  updateReport,
  deleteReport,
  executeReport,
} from '../utils/taskwarriorInstances';

export default function TaskReportsPage() {
  const { addNotification } = useNotifications();
  const { confirm, confirmationProps } = useConfirmation();

  const [activeInstance, setActiveInstance] = useState(null);
  const [builtInReports, setBuiltInReports] = useState([]);
  const [customReports, setCustomReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);

  // UI state
  const [showReportForm, setShowReportForm] = useState(false);
  const [editingReport, setEditingReport] = useState(null);
  const [selectedReport, setSelectedReport] = useState(null);
  const [reportResults, setReportResults] = useState(null);
  const [expandedReport, setExpandedReport] = useState(null);

  // Form state
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    filter: '',
    columns: 'id,description,project,tags,due,priority',
    sort: 'priority-,due+',
  });

  // Accepts the instance explicitly so the mount-time call can pass the
  // freshly fetched instance instead of reading not-yet-rendered state
  // (the previous implementation read activeInstance, which is still null
  // during initialization).
  const loadReports = async (instance = activeInstance) => {
    try {
      // Load built-in reports
      const response = await fetch('/api/taskwarrior/reports', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          rcPath: instance.rcPath || null,
          dataPath: instance.dataPath || null,
        }),
      });

      const result = await response.json();

      if (result.success) {
        setBuiltInReports(result.reports);
      }

      // Load custom reports
      const customReportsList = await getInstanceReports(instance.id);
      setCustomReports(customReportsList);
    } catch (error) {
      console.error('Error loading reports:', error);
      addNotification('Failed to load reports', 'error');
    }
  };

  useEffect(() => {
    const initializePage = async () => {
      try {
        setLoading(true);

        // Get active instance
        const instance = await getActiveInstance();
        setActiveInstance(instance);

        if (instance) {
          await loadReports(instance);
        }

        setLoading(false);
      } catch (error) {
        console.error('Error initializing reports page:', error);
        addNotification('Failed to initialize reports page', 'error');
        setLoading(false);
      }
    };

    initializePage();
    // Intentional mount-only initialization
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleExecuteReport = async (reportName, isCustom = false) => {
    if (!activeInstance) {
      addNotification('No active instance', 'error');
      return;
    }

    try {
      setExecuting(true);
      setSelectedReport(reportName);

      let tasks;
      if (isCustom) {
        // Find custom report
        const customReport = customReports.find(r => r.name === reportName);
        if (!customReport) {
          throw new Error('Custom report not found');
        }

        // Execute with custom filter
        tasks = await executeReport(reportName, activeInstance.id, customReport.filter.split(' '));
      } else {
        // Execute built-in report
        tasks = await executeReport(reportName, activeInstance.id);
      }

      setReportResults({
        reportName,
        tasks,
        timestamp: new Date().toISOString(),
      });

      setExpandedReport(reportName);
      addNotification(`Report executed: ${tasks.length} tasks`, 'success');
    } catch (error) {
      console.error('Error executing report:', error);
      addNotification(`Failed to execute report: ${error.message}`, 'error');
    } finally {
      setExecuting(false);
    }
  };

  const handleSubmitReport = async (e) => {
    e.preventDefault();

    if (!activeInstance) {
      addNotification('No active instance', 'error');
      return;
    }

    try {
      const reportData = {
        ...formData,
        instanceId: activeInstance.id,
      };

      if (editingReport) {
        await updateReport(editingReport.id, reportData);
        addNotification('Report updated', 'success');
      } else {
        await createReport(reportData);
        addNotification('Report created', 'success');
      }

      setShowReportForm(false);
      setEditingReport(null);
      setFormData({
        name: '',
        description: '',
        filter: '',
        columns: 'id,description,project,tags,due,priority',
        sort: 'priority-,due+',
      });

      await loadReports();
    } catch (error) {
      console.error('Error saving report:', error);
      addNotification('Failed to save report', 'error');
    }
  };

  const handleEditReport = (report) => {
    setEditingReport(report);
    setFormData({
      name: report.name,
      description: report.description || '',
      filter: report.filter || '',
      columns: report.columns || 'id,description,project,tags,due,priority',
      sort: report.sort || 'priority-,due+',
    });
    setShowReportForm(true);
  };

  const handleDeleteReport = async (report) => {
    if (await confirm({
      title: 'Delete Report',
      message: `Delete report "${report.name}"?`,
      type: 'danger',
      confirmLabel: 'Delete',
    })) {
      try {
        await deleteReport(report.id);
        addNotification('Report deleted', 'success');
        await loadReports();
      } catch (error) {
        console.error('Error deleting report:', error);
        addNotification('Failed to delete report', 'error');
      }
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <RefreshCw className="w-8 h-8 animate-spin text-os-text-muted" />
      </div>
    );
  }

  if (!activeInstance) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center text-os-text-muted">
          <FileText className="w-16 h-16 mx-auto mb-4 opacity-50" />
          <p>No active TaskWarrior instance</p>
          <p className="text-sm mt-2">Please configure an instance first</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-os-card-secondary dark:bg-os-masthead">
      {/* Header */}
      <div className="bg-os-card dark:bg-os-sidebar border-b border-os-border dark:border-os-sidebar-hover px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-os-text-primary">TaskWarrior Reports</h1>
            <p className="text-sm text-os-text-secondary dark:text-os-text-muted mt-1">
              Instance: {activeInstance.name}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => loadReports()}
              disabled={loading}
              className="px-3 py-2 bg-os-divider dark:bg-os-sidebar-hover text-os-text-primary hover:bg-os-border flex items-center gap-2"
            >
              <span className="text-sm">Refresh</span>
            </button>

            <button
              onClick={() => {
                setShowReportForm(true);
                setEditingReport(null);
                setFormData({
                  name: '',
                  description: '',
                  filter: '',
                  columns: 'id,description,project,tags,due,priority',
                  sort: 'priority-,due+',
                });
              }}
              className="btn btn-primary px-4 py-2 flex items-center gap-2"
            >
              <span className="text-sm font-medium">Create Custom Report</span>
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-6xl mx-auto space-y-6">
          {/* Built-in Reports */}
          <div>
            <h2 className="text-lg font-semibold text-os-text-primary mb-3">Built-in Reports</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {builtInReports.map((report) => (
                <ReportCard
                  key={report.name}
                  report={report}
                  isExecuting={executing && selectedReport === report.name}
                  isExpanded={expandedReport === report.name}
                  results={reportResults?.reportName === report.name ? reportResults : null}
                  onExecute={() => handleExecuteReport(report.name, false)}
                  onToggleExpand={() => setExpandedReport(expandedReport === report.name ? null : report.name)}
                />
              ))}
            </div>
          </div>

          {/* Custom Reports */}
          <div>
            <h2 className="text-lg font-semibold text-os-text-primary mb-3">Custom Reports</h2>
            {customReports.length === 0 ? (
              <div className="text-center py-8 text-os-text-muted bg-os-card dark:bg-os-sidebar rounded-lg border border-os-border dark:border-os-sidebar-hover">
                <FileText className="w-12 h-12 mx-auto mb-2 opacity-50" />
                <p>No custom reports</p>
                <p className="text-sm mt-1">Create your first custom report to get started</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {customReports.map((report) => (
                  <ReportCard
                    key={report.id}
                    report={report}
                    isCustom
                    isExecuting={executing && selectedReport === report.name}
                    isExpanded={expandedReport === report.name}
                    results={reportResults?.reportName === report.name ? reportResults : null}
                    onExecute={() => handleExecuteReport(report.name, true)}
                    onEdit={() => handleEditReport(report)}
                    onDelete={() => handleDeleteReport(report)}
                    onToggleExpand={() => setExpandedReport(expandedReport === report.name ? null : report.name)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Report Form Modal */}
      {showReportForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-os-card dark:bg-os-sidebar rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-os-border dark:border-os-sidebar-hover">
              <h2 className="text-lg font-semibold text-os-text-primary">
                {editingReport ? 'Edit Custom Report' : 'Create Custom Report'}
              </h2>
              <button
                onClick={() => setShowReportForm(false)}
                className="p-1 hover:bg-os-card-secondary dark:hover:bg-os-sidebar-hover rounded-sm transition-colors"
              >
                <X className="w-5 h-5 text-os-text-muted" />
              </button>
            </div>

            <form onSubmit={handleSubmitReport} className="flex-1 overflow-auto p-4 space-y-4">
              <div>
                <label className="block text-sm text-os-text-primary mb-1">
                  Report Name *
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-3 py-2 border border-os-border bg-os-card dark:bg-os-sidebar-hover text-os-text-primary"
                  placeholder="e.g., High Priority Tasks"
                  required
                  disabled={editingReport !== null}
                />
              </div>

              <div>
                <label className="block text-sm text-os-text-primary mb-1">
                  Description
                </label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="w-full px-3 py-2 border border-os-border bg-os-card dark:bg-os-sidebar-hover text-os-text-primary resize-none"
                  placeholder="Optional description of this report"
                  rows={2}
                />
              </div>

              <div>
                <label className="block text-sm text-os-text-primary mb-1">
                  Filter
                </label>
                <input
                  type="text"
                  value={formData.filter}
                  onChange={(e) => setFormData({ ...formData, filter: e.target.value })}
                  className="w-full px-3 py-2 border border-os-border bg-os-card dark:bg-os-sidebar-hover text-os-text-primary"
                  placeholder="e.g., status:pending priority:H"
                />
                <p className="text-xs text-os-text-secondary mt-1">
                  TaskWarrior filter syntax (e.g., status:pending priority:H project:Work)
                </p>
              </div>

              <div>
                <label className="block text-sm text-os-text-primary mb-1">
                  Columns
                </label>
                <input
                  type="text"
                  value={formData.columns}
                  onChange={(e) => setFormData({ ...formData, columns: e.target.value })}
                  className="w-full px-3 py-2 border border-os-border bg-os-card dark:bg-os-sidebar-hover text-os-text-primary"
                  placeholder="e.g., id,description,project,tags,due"
                />
                <p className="text-xs text-os-text-secondary mt-1">
                  Comma-separated list of columns to display
                </p>
              </div>

              <div>
                <label className="block text-sm text-os-text-primary mb-1">
                  Sort
                </label>
                <input
                  type="text"
                  value={formData.sort}
                  onChange={(e) => setFormData({ ...formData, sort: e.target.value })}
                  className="w-full px-3 py-2 border border-os-border bg-os-card dark:bg-os-sidebar-hover text-os-text-primary"
                  placeholder="e.g., priority-,due+"
                />
                <p className="text-xs text-os-text-secondary mt-1">
                  Sort order (- for descending, + for ascending)
                </p>
              </div>

              <div className="flex gap-2 pt-4 border-t border-os-border dark:border-os-sidebar-hover">
                <button
                  type="button"
                  onClick={() => setShowReportForm(false)}
                  className="px-4 py-2 bg-os-divider dark:bg-os-sidebar-hover text-os-text-primary hover:bg-os-border"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary flex-1 px-4 py-2 flex items-center justify-center gap-2"
                >
                  {editingReport ? 'Update Report' : 'Create Report'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Confirmation Modal (replaces native window.confirm) */}
      <ConfirmationModal {...confirmationProps} />
    </div>
  );
}

function ReportCard({ report, isCustom, isExecuting, isExpanded, results, onExecute, onEdit, onDelete, onToggleExpand }) {
  return (
    <div className="bg-os-card dark:bg-os-sidebar rounded-lg border border-os-border dark:border-os-sidebar-hover overflow-hidden">
      <div className="p-4">
        <div className="flex items-start justify-between mb-2">
          <div className="flex-1">
            <h3 className="font-semibold text-os-text-primary">{report.name}</h3>
            {report.description && (
              <p className="text-sm text-os-text-secondary dark:text-os-text-muted mt-1">{report.description}</p>
            )}
            {isCustom && report.filter && (
              <p className="text-xs text-os-text-secondary dark:text-os-text-secondary mt-1 font-mono">
                {report.filter}
              </p>
            )}
          </div>
          {isCustom && (
            <div className="flex items-center gap-1 ml-2">
              <button
                onClick={onEdit}
                className="p-1 hover:bg-os-card-secondary dark:hover:bg-os-sidebar-hover rounded-sm transition-colors"
                title="Edit"
              >
                <Edit2 className="w-4 h-4 text-os-text-muted" />
              </button>
              <button
                onClick={onDelete}
                className="p-1 hover:bg-os-card-secondary dark:hover:bg-os-sidebar-hover rounded-sm transition-colors"
                title="Delete"
              >
                <Trash2 className="w-4 h-4 text-red-400" />
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 mt-3">
          <button
            onClick={onExecute}
            disabled={isExecuting}
            className="btn btn-primary flex-1 px-3 py-2 flex items-center justify-center gap-2 text-sm"
          >
            
            {isExecuting ? 'Running...' : 'Run Report'}
          </button>
          {results && (
            <button
              onClick={onToggleExpand}
              className="px-3 py-2 bg-os-divider dark:bg-os-sidebar-hover text-os-text-primary hover:bg-os-border"
            >
              {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </button>
          )}
        </div>

        {results && (
          <div className="mt-3 pt-3 border-t border-os-border dark:border-os-sidebar-hover">
            <p className="text-sm text-os-text-secondary dark:text-os-text-muted">
              {results.tasks.length} task{results.tasks.length !== 1 ? 's' : ''} found
            </p>
          </div>
        )}
      </div>

      {/* Expanded Results */}
      {isExpanded && results && results.tasks.length > 0 && (
        <div className="border-t border-os-border dark:border-os-sidebar-hover bg-os-card-secondary p-4 max-h-96 overflow-auto">
          <div className="space-y-2">
            {results.tasks.map((task, idx) => (
              <div
                key={task.uuid || idx}
                className="text-sm bg-os-card dark:bg-os-sidebar p-3 rounded-sm border border-os-border dark:border-os-sidebar-hover"
              >
                <div className="font-medium text-os-text-primary">{task.description}</div>
                <div className="flex items-center gap-3 mt-1 text-xs text-os-text-secondary">
                  {task.project && <span>Project: {task.project}</span>}
                  {task.priority && <span>Priority: {task.priority}</span>}
                  {task.tags && task.tags.length > 0 && <span>Tags: {task.tags.join(', ')}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
