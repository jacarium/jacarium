import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { getAppToken, getBackendUrl } from '../utils/backendUrl';

/**
 * One interactive SSH session over the backend's Socket.IO namespace, alive
 * for the lifetime of the component that mounts this hook: connects on
 * mount, runs `sshConfig.command` once the shell is up, collects output
 * lines, and reports the exit code through `onComplete`.
 *
 * `onOutput(data)` sees every chunk of shell output first and returns true
 * to swallow it (the tab-completion echo is handled that way).
 *
 * @returns {{ output, isConnected, exitCode, addOutput, send }}
 *   send(text) writes to the shell's stdin; false when there is no socket.
 */
export default function useSSHSession({ sshConfig, onComplete, onOutput }) {
  const [output, setOutput] = useState([]);
  const [isConnected, setIsConnected] = useState(false);
  const [, setSessionId] = useState(null);
  const [exitCode, setExitCode] = useState(null);
  const socketRef = useRef(null);

  const addOutput = (line) => {
    setOutput(prev => [...prev, { ...line, timestamp: Date.now() }]);
  };

  const send = (text) => {
    if (!socketRef.current) return false;
    socketRef.current.emit('message', { type: 'input', data: text });
    return true;
  };

  useEffect(() => {
    // Start SSH session using Socket.IO
    const startSession = async () => {
      try {
        // The desktop's local backend, or - in a browser - the page's own
        // origin (the server's reverse proxy forwards Socket.IO).
        const backendUrl = await getBackendUrl();

        // The desktop backend requires the shared-secret app token (same
        // one used for the X-App-Token header on HTTP requests) during the
        // Socket.IO handshake; a server with sign-in checks the session
        // cookie instead, which the browser sends with the handshake.
        const appToken = await getAppToken();

        // Create Socket.IO connection to namespace
        const socket = io(`${backendUrl}/ws/ssh-interactive`, {
          transports: ['websocket', 'polling'],
          withCredentials: true,
          auth: appToken ? { token: appToken } : {}
        });

        socket.on('connect', () => {
          console.log('[SSH Terminal] Socket.IO connected');
          // Send connection parameters via 'message' event
          socket.emit('message', {
            type: 'connect',
            ...sshConfig
          });
        });

        // Handle SSH connection success (emitted as separate 'connected' event)
        socket.on('connected', (data) => {
          console.log('[SSH Terminal] SSH connected:', data);
          setIsConnected(true);
          setSessionId(data.sessionId);
          // Send command after connection
          if (sshConfig.command) {
            socket.emit('message', {
              type: 'input',
              data: sshConfig.command + '\n'
            });
          }
        });

        // Handle SSH output, errors, and exit (emitted as 'message' events)
        socket.on('message', (message) => {
          console.log('[SSH Terminal] Received message:', message);

          switch (message.type) {
            case 'output':
              // Tab completion echo is consumed by onOutput, never displayed
              if (!onOutput?.(message.data)) {
                addOutput({ type: 'output', text: message.data });
              }
              break;

            case 'error':
              addOutput({ type: 'error', text: message.error });
              break;

            case 'exit':
              setExitCode(message.exitCode);
              setIsConnected(false);
              addOutput({
                type: 'system',
                text: `Session closed (exit code: ${message.exitCode})`
              });
              // Auto-complete after a short delay. `output` here is the
              // mount-time value (this effect runs once), as it always was.
              setTimeout(() => {
                onComplete({
                  stdout: output.filter(o => o.type === 'output').map(o => o.text).join(''),
                  stderr: output.filter(o => o.type === 'error').map(o => o.text).join(''),
                  exitCode: message.exitCode,
                  success: message.exitCode === 0
                });
              }, 1000);
              break;

            default:
              console.warn('[SSH Terminal] Unknown message type:', message.type);
          }
        });

        socket.on('connect_error', (error) => {
          console.error('[SSH Terminal] Connection error:', error);
          addOutput({ type: 'error', text: `Connection error: ${error.message}` });
        });

        socket.on('disconnect', () => {
          console.log('[SSH Terminal] Socket.IO disconnected');
          setIsConnected(false);
        });

        socketRef.current = socket;
      } catch (error) {
        console.error('[SSH Terminal] Failed to start session:', error);
        addOutput({ type: 'error', text: `Failed to connect: ${error.message}` });
      }
    };

    startSession();

    // Cleanup on unmount
    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
    // Intentional mount-only connect: the SSH session must live for the
    // component's lifetime, not reconnect when sshConfig/output/onComplete
    // identities change between renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { output, isConnected, exitCode, addOutput, send };
}
