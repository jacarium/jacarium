import { memo } from 'react';
import { Globe } from 'lucide-react';
import { NodeHeader, DataInputPin, DataOutputPin } from './NodeComponents';
import { NodeField, NodeTextInput, NodeTextArea, NodeSelect } from './NodeFields';
import { nodeShellClass } from './nodeStyles';
import { useNodeField } from './nodeHooks';

function RESTAPINode({ data, isConnectable }) {
  const [url, setUrl] = useNodeField(data, 'url', '');
  const [method, setMethod] = useNodeField(data, 'method', 'GET');
  const [headers, setHeaders] = useNodeField(data, 'headers', '');
  const [body, setBody] = useNodeField(data, 'body', '');
  const isReadOnly = data.isReadOnly || false;
  const isShared = data.isShared || false;
  const status = data.status;

  return (
    <div className={nodeShellClass({ status, isShared, className: 'min-w-[350px]' })}>
      <NodeHeader
        icon={Globe}
        title="REST API"
        isShared={isShared}
        status={status}
        hasExecInput={true}
        hasExecOutput={true}
        isConnectable={isConnectable}
      />

      {/* Content */}
      <div className="p-3 space-y-2">
        <DataInputPin isConnectable={isConnectable} label="Override URL/headers/body" />

        <NodeField label="Method">
          <NodeSelect value={method} onChange={(e) => setMethod(e.target.value)} disabled={isReadOnly}>
            <option>GET</option>
            <option>POST</option>
            <option>PUT</option>
            <option>DELETE</option>
            <option>PATCH</option>
          </NodeSelect>
        </NodeField>

        <NodeField label="URL">
          <NodeTextInput
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={isReadOnly}
            placeholder="{{BASE_URL}}/api/endpoint"
            className="font-mono"
          />
        </NodeField>

        <NodeField label="Headers (JSON)">
          <NodeTextArea
            value={headers}
            onChange={(e) => setHeaders(e.target.value)}
            disabled={isReadOnly}
            placeholder='{"Authorization": "Bearer {{TOKEN}}"}'
            className="h-16 font-mono"
          />
        </NodeField>

        {/* Body (POST/PUT only) */}
        {['POST', 'PUT', 'PATCH'].includes(method) && (
          <NodeField label="Body (JSON)">
            <NodeTextArea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={isReadOnly}
              placeholder='{"key": "value"}'
              className="h-16 font-mono"
            />
          </NodeField>
        )}

        <DataOutputPin isConnectable={isConnectable} label="API response" />
      </div>
    </div>
  );
}

export default memo(RESTAPINode);
