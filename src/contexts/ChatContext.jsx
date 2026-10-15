import { createContext, useContext, useState, useEffect, useRef } from 'react';
import { onChatMessage, onConnectedUsersUpdate, onQuizChallenge } from '../utils/cloudWebSocket';
import { getMachineId, getDisplayName, displayNameFor } from '../utils/cloudCentralSync';
import notificationSound from '../assets/sounds/newMessage.mp3';

const ChatContext = createContext();

export function ChatProvider({ children }) {
  const [messages, setMessages] = useState([]);
  const [username, setUsername] = useState('');
  const [userId, setUserId] = useState('');
  const [unreadMentions, setUnreadMentions] = useState(0);
  const [connectedUsers, setConnectedUsers] = useState([]); // Usernames only for display
  const [connectedUserIds, setConnectedUserIds] = useState([]); // Full machineIds for challenges
  const audioRef = useRef(null);

  // Load message notification sound from MP3 file
  useEffect(() => {
    if (audioRef.current) {
      // Use imported sound (Vite will bundle this correctly for both dev and production)
      audioRef.current.src = notificationSound;
      audioRef.current.volume = 0.7; // Set volume to 70%
      audioRef.current.load();
      console.log('[ChatContext] Notification sound loaded:', notificationSound);
    }
  }, []);

  // Load username on mount
  useEffect(() => {
    async function loadUsername() {
      const machineId = await getMachineId();
      setUsername(await getDisplayName());
      setUserId(machineId);
    }
    loadUsername();
  }, []);

  // Listen for incoming chat messages (always active)
  useEffect(() => {
    const unsubscribe = onChatMessage((message) => {
      console.log('[ChatContext] Received message:', message);

      // Check if it's from another user
      const isMyMessage = message.userId === userId || message.username === username;

      if (!isMyMessage) {
        // Add message to history
        setMessages(prev => [...prev, message]);

        // Check if current user is mentioned
        if (username && message.message.includes(`@${username}`)) {
          console.log('[ChatContext] User mentioned! Incrementing unread mentions');
          setUnreadMentions(prev => prev + 1);

          // Play notification sound
          if (audioRef.current) {
            console.log('[ChatContext] Playing mention notification sound');
            audioRef.current.play().catch(err => console.log('[ChatContext] Audio play failed:', err));
          } else {
            console.log('[ChatContext] audioRef.current is null');
          }
        }
      }
    });

    return unsubscribe;
  }, [userId, username]);

  // Listen for connected users updates
  useEffect(() => {
    const unsubscribe = onConnectedUsersUpdate((users, names = {}) => {
      console.log('[ChatContext] Connected users updated:', users);
      // Store full machineIds for sending challenges
      setConnectedUserIds(users);
      // Display: the name the server knows for the user (a browser's chosen
      // name), else the username part of the machineId (without @hostname)
      const usernames = users.map(userId => displayNameFor(userId, names));
      setConnectedUsers(usernames);
    });

    return unsubscribe;
  }, []);

  // Listen for Quiz challenges
  useEffect(() => {
    if (!userId) return;

    console.log('[ChatContext] Registering quiz challenge listener for userId:', userId);

    const processedChallenges = new Set();

    const unsubscribe = onQuizChallenge((challenge) => {
      console.log('[ChatContext] Received Quiz challenge:', challenge, 'for userId:', userId);

      // Only show if it's targeted at us
      if (challenge.targetUserId !== userId) {
        console.log('[ChatContext] Challenge not for us, ignoring');
        return;
      }

      // Create unique ID for this challenge to prevent duplicates
      const challengeId = `${challenge.challengerId}-${challenge.gameId}-${challenge.timestamp}`;

      if (processedChallenges.has(challengeId)) {
        console.log('[ChatContext] Duplicate challenge detected, ignoring:', challengeId);
        return;
      }

      processedChallenges.add(challengeId);

      // Add challenge as a special message in chat
      const challengeMessage = {
        type: 'quiz-challenge',
        challengerId: challenge.challengerId,
        challengerName: challenge.challengerName,
        gameId: challenge.gameId,
        timestamp: challenge.timestamp || Date.now()
      };

      console.log('[ChatContext] Adding quiz challenge message to chat');
      setMessages(prev => {
        // Double-check we're not adding a duplicate (in case of race condition)
        const isDuplicate = prev.some(msg =>
          msg.type === 'quiz-challenge' &&
          msg.challengerId === challengeMessage.challengerId &&
          msg.gameId === challengeMessage.gameId &&
          Math.abs((msg.timestamp || 0) - (challengeMessage.timestamp || 0)) < 1000
        );

        if (isDuplicate) {
          console.log('[ChatContext] Duplicate found in messages, not adding');
          return prev;
        }

        return [...prev, challengeMessage];
      });
      setUnreadMentions(prev => prev + 1);

      // Play notification sound
      if (audioRef.current) {
        console.log('[ChatContext] Playing quiz challenge notification sound');
        audioRef.current.play().catch(err => console.log('[ChatContext] Audio play failed:', err));
      } else {
        console.log('[ChatContext] audioRef.current is null for quiz challenge');
      }
    });

    return () => {
      console.log('[ChatContext] Unregistering quiz challenge listener for userId:', userId);
      unsubscribe();
    };
  }, [userId]);

  const clearUnreadMentions = () => {
    setUnreadMentions(0);
  };

  const addMessage = (message) => {
    setMessages(prev => [...prev, message]);
  };

  const removeMessage = (filterFn) => {
    setMessages(prev => prev.filter((msg, index) => !filterFn(msg, index)));
  };

  return (
    <ChatContext.Provider value={{
      messages,
      username,
      userId,
      unreadMentions,
      connectedUsers,
      connectedUserIds,
      clearUnreadMentions,
      addMessage,
      removeMessage
    }}>
      {children}
      {/* Background notification sound - Bubble message sound */}
      <audio ref={audioRef} preload="auto" />
    </ChatContext.Provider>
  );
}

// Provider + companion export intentionally share this module (splitting
// would churn every consumer import for a hot-reload-only benefit).
// eslint-disable-next-line react-refresh/only-export-components
export function useChat() {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return context;
}
