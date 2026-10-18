import { memo } from 'react';
import { Terminal } from 'lucide-react';
import { NodeHeader, DataInputPin, DataOutputPin } from './NodeComponents';
import { NodeField, NodeTextInput, NodeTextArea, NodeSelect } from './NodeFields';
import { nodeShellClass } from './nodeStyles';
import { useNodeField } from './nodeHooks';
import { nodeFieldDefault } from './nodeDefaults';

function SSHNode({ data, isConnectable }) {
  const [host, setHost] = useNodeField(data, 'host', nodeFieldDefault('ssh', 'host'));
  const [port, setPort] = useNodeField(data, 'port', nodeFieldDefault('ssh', 'port'));
  const [username, setUsername] = useNodeField(data, 'username', nodeFieldDefault('ssh', 'username'));
  const [authMethod, setAuthMethod] = useNodeField(data, 'authMethod', nodeFieldDefault('ssh', 'authMethod')); // 'agent' or 'password'
  const [password, setPassword] = useNodeField(data, 'password', nodeFieldDefault('ssh', 'password'));
  const [command, setCommand] = useNodeField(data, 'command', nodeFieldDefault('ssh', 'command'));
  const [sshOptions, setSshOptions] = useNodeField(data, 'sshOptions', nodeFieldDefault('ssh', 'sshOptions'));
  const [interactive, setInteractive] = useNodeField(data, 'interactive', nodeFieldDefault('ssh', 'interactive'));
  const isReadOnly = data.isReadOnly || false;
  const isShared = data.isShared || false;
  const status = data.status;

  return (
    <div className={nodeShellClass({ status, isShared, className: 'min-w-[400px]' })}>
      <NodeHeader
        icon={Terminal}
        title="SSH Command"
        isShared={isShared}
        status={status}
        hasExecInput={true}
        hasExecOutput={true}
        isConnectable={isConnectable}
      />

      {/* Content */}
      <div className="p-3 space-y-2">
        <DataInputPin isConnectable={isConnectable} label="Override SSH config/command" />

        <NodeField label="Host">
          <NodeTextInput
            accent="red"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            disabled={isReadOnly}
            placeholder="example.com or {{SERVER_IP}}"
            className="font-mono"
          />
        </NodeField>

        {/* Port and Username */}
        <div className="grid grid-cols-3 gap-2">
          <NodeField label="Port">
            <NodeTextInput
              accent="red"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              disabled={isReadOnly}
              placeholder="22"
              className="font-mono"
            />
          </NodeField>
          <div className="col-span-2">
            <NodeField label="Username">
              <NodeTextInput
                accent="red"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={isReadOnly}
                placeholder="root or {{SSH_USER}}"
                className="font-mono"
              />
            </NodeField>
          </div>
        </div>

        <NodeField label="Authentication">
          <NodeSelect accent="red" value={authMethod} onChange={(e) => setAuthMethod(e.target.value)} disabled={isReadOnly}>
            <option value="agent">SSH Agent (Key-based)</option>
            <option value="password">Password</option>
          </NodeSelect>
        </NodeField>

        {/* Password (only if password auth) */}
        {authMethod === 'password' && (
          <NodeField label="Password">
            <NodeTextInput
              accent="red"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isReadOnly}
              placeholder="{{SSH_PASSWORD}}"
              className="font-mono"
            />
            <p className="text-xs text-os-text-muted mt-1">
              ⚠️ Use environment variables for sensitive data
            </p>
          </NodeField>
        )}

        <NodeField label="Command">
          <NodeTextArea
            accent="red"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            disabled={isReadOnly}
            placeholder="ls -la /var/log"
            className="h-20 font-mono"
          />
          <p className="text-xs text-os-text-muted mt-1">
            Supports environment variables: {'{{VAR_NAME}}'}
          </p>
        </NodeField>

        <NodeField label="SSH Options (optional)">
          <NodeTextArea
            accent="red"
            value={sshOptions}
            onChange={(e) => setSshOptions(e.target.value)}
            disabled={isReadOnly}
            placeholder="-o KexAlgorithms=curve25519-sha256,ecdh-sha2-nistp256&#10;-o StrictHostKeyChecking=no"
            className="h-16 font-mono"
          />
          <p className="text-xs text-os-text-muted mt-1">
            Custom SSH flags (one per line or space-separated)
          </p>
        </NodeField>

        {/* Interactive Mode */}
        <div className="flex items-center gap-2 p-2 bg-os-card-secondary rounded-sm">
          <input
            type="checkbox"
            id={`interactive-${data.id || 'ssh'}`}
            checked={interactive}
            onChange={(e) => setInteractive(e.target.checked)}
            disabled={isReadOnly}
            className="nodrag w-4 h-4 text-red-600 focus:ring-red-500 border-os-border rounded-sm"
          />
          <label htmlFor={`interactive-${data.id || 'ssh'}`} className="text-xs text-os-text-primary cursor-pointer flex-1">
            <span className="font-medium">Interactive Mode</span>
            <span className="text-os-text-muted block">Show terminal UI for prompts & links</span>
          </label>
        </div>

        <DataOutputPin isConnectable={isConnectable} label="Command output (stdout)" />
      </div>
    </div>
  );
}

export default memo(SSHNode);
