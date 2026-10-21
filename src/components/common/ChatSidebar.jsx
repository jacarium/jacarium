import { useState, useEffect, useRef, useMemo } from 'react';
import { MessageSquare, User, FileText, Trello, Brain, Check, X, GitBranch } from 'lucide-react';
import SidebarHeader from './sidebar/SidebarHeader';
import ResizableSidebar from '../ResizableSidebar';
import { ChatSendButton, chatComposerInputClass, CHAT_COMPOSER_ROWS } from '../ui/primitives';
import { sendChatMessage, isWebSocketConnected } from '../../utils/cloudWebSocket';
import { getUserColor, getUserColorDark } from '../../utils/userColors';
import { getDocumentsMetadata } from '../../utils/documents';
import { getBoards } from '../../utils/kanban';
import { getWorkflows } from '../../utils/workflows';
import { useChat } from '../../contexts/ChatContext';

/**
 * ChatSidebar - Resizable sidebar for real-time chat between connected users
 */
export default function ChatSidebar({ isOpen, side = 'left' }) {
  const { messages, username, userId, addMessage, removeMessage, clearUnreadMentions, connectedUsers } = useChat();
  const [inputValue, setInputValue] = useState('');
  const [documents, setDocuments] = useState([]);
  const [boards, setBoards] = useState([]);
  const [workflows, setWorkflows] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [mentionSearch, setMentionSearch] = useState('');
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  // Load documents, boards, and workflows on mount
  useEffect(() => {
    async function loadData() {
      // Metadata only: mentions need just id/title/inCloud
      const docs = await getDocumentsMetadata();
      // Only include cloud documents for mentions
      const cloudDocs = docs.filter(doc => doc.inCloud);
      setDocuments(cloudDocs);

      const allBoards = await getBoards();
      // Only include cloud boards for mentions
      const cloudBoards = allBoards.filter(board => board.inCloud);
      setBoards(cloudBoards);

      const allWorkflows = await getWorkflows();
      // Only include cloud workflows for mentions
      const cloudWorkflows = allWorkflows.filter(wf => wf.inCloud);
      setWorkflows(cloudWorkflows);
    }

    loadData();
  }, []);

  // Clear unread mentions when chat is opened
  useEffect(() => {
    if (isOpen) {
      clearUnreadMentions();
    }
  }, [isOpen, clearUnreadMentions]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function handleInputChange(e) {
    const value = e.target.value;
    setInputValue(value);

    // Check if user is typing @ mention
    const cursorPos = e.target.selectionStart;
    const textBeforeCursor = value.substring(0, cursorPos);
    const atIndex = textBeforeCursor.lastIndexOf('@');

    if (atIndex !== -1 && atIndex === textBeforeCursor.length - 1) {
      // Just typed @
      setMentionSearch('');
      setShowSuggestions(true);
    } else if (atIndex !== -1) {
      // Typing after @
      const searchText = textBeforeCursor.substring(atIndex + 1);
      // Only show if there's no space (means we're still in the mention)
      if (!searchText.includes(' ')) {
        setMentionSearch(searchText.toLowerCase());
        setShowSuggestions(true);
      } else {
        setShowSuggestions(false);
      }
    } else {
      setShowSuggestions(false);
    }
  }

  function handleSelectSuggestion(mention) {
    const cursorPos = inputRef.current.selectionStart;
    const textBeforeCursor = inputValue.substring(0, cursorPos);
    const textAfterCursor = inputValue.substring(cursorPos);
    const atIndex = textBeforeCursor.lastIndexOf('@');

    if (atIndex !== -1) {
      const newValue = inputValue.substring(0, atIndex) + '@' + mention + ' ' + textAfterCursor;
      setInputValue(newValue);
      setShowSuggestions(false);

      // Focus back on input
      setTimeout(() => {
        if (inputRef.current) {
          const newCursorPos = atIndex + mention.length + 2; // @ + mention + space
          inputRef.current.focus();
          inputRef.current.setSelectionRange(newCursorPos, newCursorPos);
        }
      }, 0);
    }
  }

  async function handleSendMessage(e) {
    e.preventDefault();

    if (!inputValue.trim()) return;

    const message = inputValue.trim();

    // Check for @quiz @user pattern (changed from @challenge-quiz)
    const challengePattern = /@quiz\s+@([\w-]+)/i;
    const challengeMatch = message.match(challengePattern);

    if (challengeMatch) {
      const targetUser = challengeMatch[1];

      // Check if target user is connected
      if (!connectedUsers.includes(targetUser)) {
        // Add error message to chat
        addMessage({
          username: 'System',
          userId: 'system',
          message: `❌ Cannot send Quiz challenge: User "${targetUser}" is not connected.`,
          timestamp: Date.now()
        });
        setInputValue('');
        setShowSuggestions(false);
        return;
      }

      // Check if WebSocket is connected
      if (!isWebSocketConnected()) {
        addMessage({
          username: 'System',
          userId: 'system',
          message: `❌ Cannot send Quiz challenge: Not connected to central server.`,
          timestamp: Date.now()
        });
        setInputValue('');
        setShowSuggestions(false);
        return;
      }

      // Send Quiz challenge (open quiz window first)
      try {
        // Open quiz window and wait for it to create the game
        window.dispatchEvent(new CustomEvent('sendQuizChallenge', {
          detail: { targetUser }
        }));

        // Add confirmation message to chat
        addMessage({
          username: 'System',
          userId: 'system',
          message: `🧠 Quiz challenge sent to @${targetUser}! Waiting for response...`,
          timestamp: Date.now()
        });

        // Also send the message to chat for visibility
        const chatMessage = {
          username,
          userId,
          message,
          timestamp: Date.now()
        };
        addMessage(chatMessage);
        await sendChatMessage(message);
      } catch (error) {
        console.error('Error sending Quiz challenge:', error);
        addMessage({
          username: 'System',
          userId: 'system',
          message: `❌ Failed to send Quiz challenge: ${error.message}`,
          timestamp: Date.now()
        });
      }

      setInputValue('');
      setShowSuggestions(false);
      return;
    }

    // Normal message flow
    const chatMessage = {
      username,
      userId,
      message,
      timestamp: Date.now()
    };
    addMessage(chatMessage);

    // Send message via WebSocket
    await sendChatMessage(message);

    // Clear input
    setInputValue('');
    setShowSuggestions(false);
  }

  function formatTime(timestamp) {
    const date = new Date(timestamp);
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  // Parse message for @mentions (users, documents, boards, workflows, and commands)
  function parseMentions(text) {
    const parts = [];
    let lastIndex = 0;
    const mentionRegex = /@([\w-]+)/g;
    let match;

    while ((match = mentionRegex.exec(text)) !== null) {
      // Add text before mention
      if (match.index > lastIndex) {
        parts.push({
          type: 'text',
          content: text.substring(lastIndex, match.index)
        });
      }

      const mentionText = match[1];

      // Check if it's a command (changed from challenge-quiz to quiz)
      if (mentionText === 'quiz') {
        parts.push({
          type: 'command',
          content: match[0],
          displayText: mentionText
        });
      } else {
        // Check if it's a document mention
        const document = documents.find(doc =>
          doc.title.toLowerCase().replace(/\s+/g, '-') === mentionText.toLowerCase() ||
          doc.title.toLowerCase() === mentionText.toLowerCase()
        );

        if (document) {
          parts.push({
            type: 'document',
            content: match[0],
            documentId: document.id,
            documentTitle: document.title
          });
        } else {
          // Check if it's a board mention
          const board = boards.find(b =>
            b.title.toLowerCase().replace(/\s+/g, '-') === mentionText.toLowerCase() ||
            b.title.toLowerCase() === mentionText.toLowerCase()
          );

          if (board) {
            parts.push({
              type: 'board',
              content: match[0],
              boardId: board.id,
              boardTitle: board.title
            });
          } else {
            // Check if it's a workflow mention
            const workflow = workflows.find(wf =>
              wf.title.toLowerCase().replace(/\s+/g, '-') === mentionText.toLowerCase() ||
              wf.title.toLowerCase() === mentionText.toLowerCase()
            );

            if (workflow) {
              parts.push({
                type: 'workflow',
                content: match[0],
                workflowId: workflow.id,
                workflowTitle: workflow.title
              });
            } else {
              // User mention
              parts.push({
                type: 'user',
                content: match[0],
                isCurrentUser: mentionText === username,
                userName: mentionText
              });
            }
          }
        }
      }

      lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    if (lastIndex < text.length) {
      parts.push({
        type: 'text',
        content: text.substring(lastIndex)
      });
    }

    return parts.length > 0 ? parts : [{ type: 'text', content: text }];
  }

  function handleDocumentMentionClick(documentId) {
    // Dispatch event to open document
    window.dispatchEvent(new CustomEvent('openDocument', {
      detail: { documentId }
    }));
  }

  function handleBoardMentionClick(boardId) {
    // Dispatch event to open board
    window.dispatchEvent(new CustomEvent('openBoard', {
      detail: { boardId }
    }));
  }

  function handleWorkflowMentionClick(workflowId) {
    // Dispatch event to open workflow
    window.dispatchEvent(new CustomEvent('openWorkflow', {
      detail: { workflowId }
    }));
  }

  // Handle Quiz challenge acceptance
  async function handleAcceptQuizChallenge(challengerId, challengerName, gameId) {
    const { sendQuizChallengeResponse } = await import('../../utils/cloudWebSocket');
    await sendQuizChallengeResponse(challengerId, true, gameId);

    // Remove the quiz challenge popup from the chat
    removeMessage((msg) => msg.type === 'quiz-challenge' && msg.gameId === gameId);

    // Add confirmation message
    addMessage({
      username: 'System',
      userId: 'system',
      message: `🧠 Challenge accepted! Joining game...`,
      timestamp: Date.now()
    });

    // Dispatch event to join the quiz as guest
    window.dispatchEvent(new CustomEvent('quizChallengeAccepted', {
      detail: {
        gameId,
        opponentId: challengerId,
        opponentName: challengerName
      }
    }));
  }

  // Handle Quiz challenge decline
  async function handleDeclineQuizChallenge(challengerId, gameId) {
    const { sendQuizChallengeResponse } = await import('../../utils/cloudWebSocket');
    await sendQuizChallengeResponse(challengerId, false, gameId);

    // Remove the quiz challenge popup from the chat
    removeMessage((msg) => msg.type === 'quiz-challenge' && msg.gameId === gameId);

    // Add confirmation message
    addMessage({
      username: 'System',
      userId: 'system',
      message: `🧠 Challenge declined`,
      // eslint-disable-next-line react-hooks/purity -- click handler, not render; impure Date.now() is fine here
      timestamp: Date.now()
    });
  }

  // Filter suggestions based on search
  const filteredSuggestions = useMemo(() => {
    const suggestions = [];

    // Add quiz command (changed from challenge-quiz to quiz)
    if (!mentionSearch || 'quiz'.includes(mentionSearch)) {
      suggestions.push({
        type: 'command',
        value: 'quiz',
        display: 'quiz @user',
        description: 'Challenge someone to Quiz'
      });
    }

    // Add connected users
    connectedUsers.forEach(user => {
      if (!mentionSearch || user.toLowerCase().includes(mentionSearch)) {
        suggestions.push({ type: 'user', value: user, display: user });
      }
    });

    // Add cloud documents
    documents.forEach(doc => {
      const searchTitle = doc.title.toLowerCase().replace(/\s+/g, '-');
      if (!mentionSearch || searchTitle.includes(mentionSearch) || doc.title.toLowerCase().includes(mentionSearch)) {
        suggestions.push({
          type: 'document',
          value: searchTitle,
          display: doc.title,
          documentTitle: doc.title
        });
      }
    });

    // Add cloud boards
    boards.forEach(board => {
      const searchTitle = board.title.toLowerCase().replace(/\s+/g, '-');
      if (!mentionSearch || searchTitle.includes(mentionSearch) || board.title.toLowerCase().includes(mentionSearch)) {
        suggestions.push({
          type: 'board',
          value: searchTitle,
          display: board.title,
          boardTitle: board.title
        });
      }
    });

    // Add cloud workflows
    workflows.forEach(workflow => {
      const searchTitle = workflow.title.toLowerCase().replace(/\s+/g, '-');
      if (!mentionSearch || searchTitle.includes(mentionSearch) || workflow.title.toLowerCase().includes(mentionSearch)) {
        suggestions.push({
          type: 'workflow',
          value: searchTitle,
          display: workflow.title,
          workflowTitle: workflow.title
        });
      }
    });

    return suggestions.slice(0, 15); // Limit to 15 suggestions
  }, [connectedUsers, documents, boards, workflows, mentionSearch]);

  if (!isOpen) return null;

  return (
    <ResizableSidebar
      defaultWidth={300}
      minWidth={250}
      maxWidth={500}
      storageKey="chat-sidebar-width"
      side={side}
      canvasMinWidth={480}
      testId="panel-team-chat"
    >
      <div className={`flex flex-col h-full bg-os-card ${side === 'right' ? 'border-l' : 'border-r'} border-os-border`}>
        {/* Header */}
        <SidebarHeader
          title="Team Chat"
          icon={MessageSquare}
        />

        {/* Messages Area */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
              <div className="p-3 bg-os-card-secondary rounded-full mb-3">
                <MessageSquare size={24} className="text-os-text-muted" />
              </div>
              <p className="text-sm text-os-text-secondary">No messages yet</p>
              <p className="text-xs text-os-text-muted mt-1">Start chatting with your team</p>
            </div>
          ) : (
            <>
              {messages.map((msg, index) => {
                // Handle Quiz challenge messages
                if (msg.type === 'quiz-challenge') {
                  const gameType = msg.gameId?.startsWith('grid-') ? 'Grid' :
                                   msg.gameId?.startsWith('tiles-') ? 'Tiles' : 'Quiz';
                  const iconColor = msg.gameId?.startsWith('grid-') ? 'text-yellow-500' :
                                    msg.gameId?.startsWith('tiles-') ? 'text-purple-500' : 'text-os-blue';
                  const borderColor = msg.gameId?.startsWith('grid-') ? 'border-yellow-500' :
                                      msg.gameId?.startsWith('tiles-') ? 'border-purple-500' : 'border-os-blue';

                  return (
                    <div key={index} className="flex flex-col items-center my-2">
                      <div className={`bg-os-card border-2 ${borderColor} rounded-lg p-4 max-w-[90%]`}>
                        <div className="flex items-center gap-3 mb-3">
                          <Brain size={32} className={iconColor} />
                          <div>
                            <p className="text-sm font-semibold text-os-text-primary">
                              {gameType} Challenge!
                            </p>
                            <p className="text-xs text-os-text-secondary">
                              <span className="font-bold">{msg.challengerName}</span> has challenged you to a {gameType}
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleDeclineQuizChallenge(msg.challengerId, msg.gameId)}
                            className="flex-1 px-3 py-2 bg-os-card-secondary hover:bg-os-border text-os-text-primary border border-os-border rounded-sm transition-colors flex items-center justify-center gap-1 text-sm"
                          >
                            <X size={14} />
                            Decline
                          </button>
                          <button
                            onClick={() => handleAcceptQuizChallenge(msg.challengerId, msg.challengerName, msg.gameId)}
                            className="flex-1 px-3 py-2 bg-os-blue hover:bg-os-blue-hover text-white rounded-sm transition-colors flex items-center justify-center gap-1 text-sm"
                          >
                            <Check size={14} />
                            Accept
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                }

                // Regular messages
                const isOwnMessage = msg.username === username;
                const userColor = getUserColor(msg.userId || msg.username);
                const userColorDark = getUserColorDark(msg.userId || msg.username);
                const mentionParts = parseMentions(msg.message || '');

                return (
                  <div
                    key={index}
                    className={`flex flex-col ${isOwnMessage ?'items-end':'items-start'}`}
                  >
                    <div className="flex items-baseline gap-2 mb-1">
                      <span
                        className="text-xs font-semibold"
                        style={{ color: userColor }}
                      >
                        {msg.username}
                      </span>
                      <span className="text-xs text-os-text-muted">
                        {formatTime(msg.timestamp)}
                      </span>
                    </div>
                    <div
                      className="max-w-[80%] px-3 py-2 rounded-lg text-white"
                      style={{ backgroundColor: userColorDark }}
                    >
                      <p className="text-sm whitespace-pre-wrap wrap-break-word">
                        {mentionParts.map((part, partIndex) => {
                          if (part.type === 'document') {
                            return (
                              <span
                                key={partIndex}
                                onClick={() => handleDocumentMentionClick(part.documentId)}
                                className="inline-flex items-center gap-1 font-bold underline cursor-pointer hover:opacity-80"
                                title={`Open document: ${part.documentTitle}`}
                              >
                                <FileText size={12} className="inline" />
                                {part.documentTitle}
                              </span>
                            );
                          } else if (part.type === 'board') {
                            return (
                              <span
                                key={partIndex}
                                onClick={() => handleBoardMentionClick(part.boardId)}
                                className="inline-flex items-center gap-1 font-bold underline cursor-pointer hover:opacity-80"
                                title={`Open board: ${part.boardTitle}`}
                              >
                                <Trello size={12} className="inline" />
                                {part.boardTitle}
                              </span>
                            );
                          } else if (part.type === 'workflow') {
                            return (
                              <span
                                key={partIndex}
                                onClick={() => handleWorkflowMentionClick(part.workflowId)}
                                className="inline-flex items-center gap-1 font-bold underline cursor-pointer hover:opacity-80"
                                title={`Open workflow: ${part.workflowTitle}`}
                              >
                                <GitBranch size={12} className="inline" />
                                {part.workflowTitle}
                              </span>
                            );
                          } else if (part.type === 'command') {
                            return (
                              <span
                                key={partIndex}
                                className="inline-flex items-center gap-1 font-bold bg-white/30 px-1 rounded-sm"
                              >
                                <Brain size={12} className="inline" />
                                {part.displayText}
                              </span>
                            );
                          } else if (part.type === 'user') {
                            return (
                              <span
                                key={partIndex}
                                className={`inline-flex items-center gap-1 font-bold ${part.isCurrentUser ?'bg-yellow-300 text-os-text-primary px-1 rounded-sm':''}`}
                              >
                                <User size={12} className="inline" />
                                {part.userName}
                              </span>
                            );
                          } else {
                            return <span key={partIndex}>{part.content}</span>;
                          }
                        })}
                      </p>
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        {/* Input Area */}
        <form onSubmit={handleSendMessage} className="border-t border-os-border p-3">
          <div className="relative flex items-end gap-2">
            {/* Suggestions Dropdown */}
            {showSuggestions && filteredSuggestions.length > 0 && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setShowSuggestions(false)}
                />
                <div className="absolute bottom-full left-0 mb-2 z-20 bg-os-card border border-os-border shadow-lg rounded-md py-1 min-w-[250px] max-h-[300px] overflow-y-auto">
                  <div className="px-3 py-1 text-xs text-os-text-muted font-semibold">
                    Mention user, document, board, or workflow
                  </div>
                  {filteredSuggestions.map((suggestion, index) => (
                    <button
                      key={index}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        handleSelectSuggestion(suggestion.value);
                      }}
                      className="w-full px-3 py-2 text-left text-sm text-os-text-primary hover:bg-os-card-secondary flex items-center gap-2"
                    >
                      <span className="flex-1 truncate">
                        {suggestion.type === 'command' ? suggestion.display :
                         suggestion.type === 'user' ? suggestion.display :
                         suggestion.type === 'document' ? suggestion.documentTitle :
                         suggestion.type === 'board' ? suggestion.boardTitle :
                         suggestion.workflowTitle}
                      </span>
                      {suggestion.type === 'command' && (
                        <span className="text-xs text-os-text-muted">cmd</span>
                      )}
                      {suggestion.type === 'document' && (
                        <span className="text-xs text-os-text-muted">doc</span>
                      )}
                      {suggestion.type === 'board' && (
                        <span className="text-xs text-os-text-muted">board</span>
                      )}
                      {suggestion.type === 'workflow' && (
                        <span className="text-xs text-os-text-muted">workflow</span>
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}

            {/* the AI Chat sidebar's composer: the same box and send button (Enter sends, Shift+Enter breaks the line) */}
            <textarea
              ref={inputRef}
              value={inputValue}
              onChange={handleInputChange}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !showSuggestions) {
                  e.preventDefault();
                  handleSendMessage(e);
                }
              }}
              placeholder="Type a message... (@user, @document, @board, @workflow, or @quiz)"
              className={chatComposerInputClass('purple')}
              rows={CHAT_COMPOSER_ROWS}
              data-testid="team-chat-input"
            />
            <ChatSendButton accent="purple" type="submit" disabled={!inputValue.trim()} data-testid="team-chat-send" />
          </div>
        </form>
      </div>
    </ResizableSidebar>
  );
}
