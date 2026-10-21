import TransferTextModal from '../common/TransferTextModal';

/**
 * Export / import workflows as one Base64 string: TransferTextModal in its
 * base64 format (the JSON export shares the dialog).
 */
export default function Base64TransferModal(props) {
  return <TransferTextModal format="base64" {...props} />;
}
