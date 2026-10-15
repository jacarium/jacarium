import ImportStats from '../../common/ImportStats';
import { describeDocumentsImport } from '../../../utils/documentImport';

/* eslint-disable react-refresh/only-export-components -- the merge label/hint belong with the stats wording */
/**
 * The shared ImportStats block with the Documents import's wording
 * (src/utils/documentImport.js runDocumentsImport / describeDocumentsImport):
 * rows for Documents, one per target category (marked "(new)" where the
 * category does not exist yet) and Images; the same block is shown for a
 * dry run and after the real import.
 */
export default function DocumentsImportStats({ result }) {
  const text = describeDocumentsImport(result);
  const merge = result.mergeMode === true;
  return (
    <ImportStats
      result={result}
      title={text.title}
      headline={text.headline}
      hint={text.hint}
      emptyText="The file contains no documents to import."
      typeLabels={{ documents: 'Documents', images: 'Images' }}
      columnLabels={merge
        ? { created: 'New', updated: 'Replaced', filled: 'Completed', skipped: 'Unchanged', invalid: 'Invalid' }
        : { created: 'New', skipped: 'Reused', invalid: 'Invalid' }}
    />
  );
}

/** Label + hint of the merge checkbox (ImportInputModal and the Base64 modal). */
export const DOCUMENTS_MERGE_LABEL = 'Keep existing documents and merge newer copies';

export function documentsMergeHint(checked) {
  return checked
    ? 'Documents already here (same stableId, or the same title and category) are kept: a newer copy from the file replaces them, otherwise only empty fields are filled in; locked documents are never changed. Everything else is added.'
    : 'Every document in the file is added as a new document, even when one with the same title already exists. Tick to merge into the existing documents instead.';
}
