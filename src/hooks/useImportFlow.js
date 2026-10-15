import { useState } from 'react';

/**
 * Custom hook for managing the complete import flow
 * Handles both input modal and progress modal states
 *
 * @param {Object} config - Configuration object
 * @param {Function} config.validateFn - Function to validate imported data
 * @param {Function} config.onRun - (items, { dryRun, onProgress }) => result; the
 *   one runner for the dry run and the real import
 * @param {Function} [config.onComplete] - called with the result after a real import
 * @returns {Object} Import flow state and handlers
 */
export function useImportFlow({ validateFn, onRun, onComplete = null }) {
  const [showInputModal, setShowInputModal] = useState(false);
  const [showProgressModal, setShowProgressModal] = useState(false);
  const [importData, setImportData] = useState(null);
  // Options chosen in the input modal (e.g. { mergeMode }) for the real run
  const [importOptions, setImportOptions] = useState({});

  const startImport = () => {
    setShowInputModal(true);
  };

  const handleInputValidated = (data, options = {}) => {
    setImportOptions(options);
    setImportData(data);
    setShowInputModal(false);
    setShowProgressModal(true);
  };

  const handleInputClose = () => {
    setShowInputModal(false);
  };

  const handleProgressClose = () => {
    setShowProgressModal(false);
    setImportData(null);
  };

  return {
    // State
    showInputModal,
    showProgressModal,
    importData,
    importOptions,

    // Handlers
    startImport,
    handleInputValidated,
    handleInputClose,
    handleProgressClose,

    // Config
    validateFn,
    onRun,
    onComplete,
  };
}
