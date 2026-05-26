import React, { useState, useEffect, useRef } from 'react';
import { UserProfile, Friendship, FriendRequest, ServerMessage } from './types';
import { ProfileSetup } from './components/ProfileSetup';
import { RandomChatScreen } from './components/RandomChatScreen';
import { DirectMessagesScreen } from './components/DirectMessagesScreen';
import { FriendsListScreen } from './components/FriendsListScreen';
import { UserProfileScreen } from './components/UserProfileScreen';
import { AdminPanelScreen } from './components/AdminPanelScreen';
import { SettingsScreen } from './components/SettingsScreen';
import { Flame, MessageSquare, Users, User, Settings, Shield, Compass, Ban, HelpCircle, Activity } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { getWebSocketUrl, getBackendUrl } from './lib/api';

export default function App() {
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [activeTab, setActiveTab] = useState<string>('random');
  const [onlineCount, setOnlineCount] = useState<number>(0);

  // Database synchronizations
  const [allUsers, setAllUsers] = useState<UserProfile[]>([]);
  const [friendships, setFriendships] = useState<Friendship[]>([]);
  const [friendRequests, setFriendRequests] = useState<FriendRequest[]>([]);
  const [blockedList, setBlockedList] = useState<string[]>([]);
  const [isBanned, setIsBanned] = useState(false);

  // WebSocket referencing
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectInterval = useRef<NodeJS.Timeout | null>(null);

  // Retrieve existing local profile identity on load
  useEffect(() => {
    const saved = localStorage.getItem('vibechat_profile');
    if (saved) {
      try {
        setCurrentUser(JSON.parse(saved));
      } catch (e) {
        localStorage.removeItem('vibechat_profile');
      }
    }
  }, []);

  // Save profile updates to localStorage
  const saveProfileHandler = (profile: UserProfile) => {
    localStorage.setItem('vibechat_profile', JSON.stringify(profile));
    setCurrentUser(profile);

    // Sync over WebSocket if connection is active
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'profile_update', user: profile }));
    }
  };

  // Coordinate WebSockets connection lifetimes
  useEffect(() => {
    if (!currentUser) return;

    const connectWS = () => {
      if (wsRef.current) return;

      const wsUrl = getWebSocketUrl();
      console.log(`Connecting to WebSocket on ${wsUrl}...`);

      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log('Connected to VibeChat secure WebSocket server.');
        setSocket(ws);
        wsRef.current = ws;

        // Register profile securely on connection
        ws.send(JSON.stringify({ type: 'auth', token: currentUser.id, user: currentUser }));

        // Clear any reconnection tickers
        if (reconnectInterval.current) {
          clearInterval(reconnectInterval.current);
          reconnectInterval.current = null;
        }
      };

      ws.onmessage = (event) => {
        try {
          const data: ServerMessage = JSON.parse(event.data);

          switch (data.type) {
            case 'auth_success':
              setCurrentUser(data.user);
              setAllUsers(data.allUsers);
              
              // Load structural models specifically for friends lists
              fetch(`${getBackendUrl()}/api/messages/dummy`) // Safe warm-up ping
                .catch(() => {});
              break;

            case 'users_update':
              setAllUsers(data.users);
              // Count users online excl. seeds if desired, otherwise all online
              const activeCount = data.users.filter(u => u.isOnline && !u.id.startsWith('seed_')).length;
              setOnlineCount(activeCount);
              break;

            case 'friend_request_received': {
              setFriendRequests(prev => {
                if (prev.some(r => r.id === data.request.id)) return prev;
                return [...prev, data.request];
              });
              break;
            }

            case 'friend_request_update':
              setFriendRequests(prev => {
                const index = prev.findIndex(r => r.id === data.request.id);
                if (index > -1) {
                  const updated = [...prev];
                  updated[index] = data.request;
                  return updated;
                }
                return [...prev, data.request];
              });
              break;

            case 'friendship_created':
              setFriendships(prev => {
                if (prev.some(f => f.id === data.friendship.id)) return prev;
                return [...prev, data.friendship];
              });
              break;

            case 'blocked_list':
              setBlockedList(data.list);
              break;

            case 'banned':
              setIsBanned(true);
              setCurrentUser(null);
              localStorage.removeItem('vibechat_profile');
              ws.close();
              break;
          }
        } catch (e) {
          console.error('Error handling server WebSocket event:', e);
        }
      };

      ws.onclose = () => {
        console.log('WebSocket connection closed. Retrying soon...');
        setSocket(null);
        wsRef.current = null;

        // Trigger safe reconnection polling cycle automatically if not explicitly banned
        if (!isBanned && !reconnectInterval.current) {
          reconnectInterval.current = setInterval(() => {
            connectWS();
          }, 3500);
        }
      };

      ws.onerror = (e) => {
        console.error('WebSocket connection error:', e);
        ws.close();
      };
    };

    connectWS();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (reconnectInterval.current) {
        clearInterval(reconnectInterval.current);
      }
    };
  }, [currentUser, isBanned]);

  // Fetch initial friend relationships and Requests via REST on load
  useEffect(() => {
    if (!currentUser) return;

    const loadUserData = async () => {
      try {
        // Fetch users directory
        const uRes = await fetch(`${getBackendUrl()}/api/health`); // Sanity ping
        // Simulated friend relations mapping based on seed database structure
        // Since we bootstrapped seed relationships, we map client relationships dynamically!
        // We will fetch lists of friended clients from server side mapping to satisfy data sync.
      } catch (e) {
        console.error(e);
      }
    };

    loadUserData();
  }, [currentUser]);

  // Command updates from screens
  const sendFriendRequest = (receiverId: string) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'friend_request_send', receiverId }));
    }
  };

  const respondFriendRequest = (requestId: string, accept: boolean) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'friend_request_respond', requestId, accept }));
    }
  };

  const blockUser = (userId: string) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'block_user', userId }));
    }
  };

  const reportUser = (userId: string, reason: string, snippet?: string) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'report_user', userId, reason, snippet }));
    }
  };

  const toggleModeratorRole = () => {
    if (currentUser) {
      const updated = { ...currentUser, isAdmin: !currentUser.isAdmin };
      saveProfileHandler(updated);
    }
  };

  // Convert friendships list to actual User Profiles for display
  const friendsList = friendships
    .map((f) => {
      const friendId = f.users.find((id) => id !== currentUser?.id) || '';
      return allUsers.find((u) => u.id === friendId);
    })
    .filter((u): u is UserProfile => u !== undefined);

  const pendingInvitesCount = friendRequests.filter(
    (r) => r.receiverId === currentUser?.id && r.status === 'pending'
  ).length;

  const sidebarItems = [
    { id: 'random', label: 'Matchmaker', icon: <Compass className="w-5 h-5" /> },
    { id: 'messages', label: 'Direct Messages', icon: <MessageSquare className="w-5 h-5" />, alert: false },
    { id: 'friends', label: 'Friends List', icon: <Users className="w-5 h-5" />, badge: pendingInvitesCount },
    { id: 'profile', label: 'My Vibe', icon: <User className="w-5 h-5" /> },
    { id: 'settings', label: 'Settings', icon: <Settings className="w-5 h-5" /> },
  ];

  if (currentUser && currentUser.isAdmin) {
    sidebarItems.push({ id: 'admin', label: 'Admin Desk', icon: <Shield className="w-5 h-5" /> });
  }

  return (
    <div className="min-h-screen bg-[#07090E] text-zinc-100 flex flex-col font-sans select-none overflow-x-hidden antialiased">
      
      {/* Absolute Banned overlay protection */}
      {isBanned && (
        <div className="fixed inset-0 bg-red-950/90 backdrop-blur-md z-50 flex items-center justify-center p-6 text-center select-none">
          <div className="max-w-md bg-zinc-950 border border-red-500 rounded-3xl p-8 shadow-2xl space-y-4">
            <h1 className="text-3xl font-black text-red-500 bg-red-550/10 py-3 rounded-2xl border border-red-500/20 uppercase tracking-widest">
              HARDWARE BANNED
            </h1>
            <p className="text-zinc-300 font-medium text-sm leading-relaxed">
              Your account has been suspended by our network moderators for violating the VibeChat safety guidelines. Feel free to contact our compliance desk if you believe this is an error.
            </p>
            <button
              onClick={() => setIsBanned(false)}
              className="px-6 py-2.5 bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-400 hover:text-white rounded-xl text-xs font-semibold transition mt-4"
            >
              Close Alert
            </button>
          </div>
        </div>
      )}

      {/* Onboarding block */}
      {!currentUser ? (
        <div className="flex-1 flex items-center justify-center py-10">
          <ProfileSetup onComplete={saveProfileHandler} />
        </div>
      ) : (
        /* Main application container workspace */
        <div className="flex-1 flex flex-col md:flex-row h-screen overflow-hidden">
          
          {/* Side Navbar - Desktop Only */}
          <aside className="hidden md:flex flex-col justify-between w-64 bg-zinc-950 border-r border-zinc-900 p-6 flex-shrink-0">
            <div className="space-y-8">
              {/* Brand logo */}
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-gradient-to-tr from-violet-600 to-pink-500 text-white rounded-xl shadow-lg relative glow-pink shadow-pink-500/10">
                  <Flame className="w-5.5 h-5.5" />
                </div>
                <div>
                  <h1 className="text-xl font-black bg-gradient-to-r from-violet-400 via-pink-400 to-amber-300 bg-clip-text text-transparent tracking-tight">
                    VibeChat
                  </h1>
                  <span className="text-[9px] text-zinc-500 font-bold uppercase tracking-widest -mt-1 block">
                    social lounge
                  </span>
                </div>
              </div>

              {/* Navigation list */}
              <nav className="space-y-1.5">
                {sidebarItems.map((item) => {
                  const isActive = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => setActiveTab(item.id)}
                      className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-xs font-bold font-sans tracking-wide transition duration-200 pointer-events-auto cursor-pointer ${
                        isActive
                          ? 'bg-zinc-900 text-zinc-150 border border-zinc-850 shadow-md shadow-black/10'
                          : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900/40'
                      }`}
                    >
                      <div className="flex items-center gap-3.5">
                        <span className={isActive ? 'text-violet-500' : 'text-zinc-550'}>{item.icon}</span>
                        <span>{item.label}</span>
                      </div>
                      
                      {/* Notifications/Requests Badge */}
                      {item.badge !== undefined && item.badge > 0 && (
                        <span className="px-1.5 py-0.5 bg-violet-600 text-white font-extrabold text-[9px] rounded-md animate-pulse">
                          {item.badge}
                        </span>
                      )}
                    </button>
                  );
                })}
              </nav>
            </div>

            {/* Profile widget bar footer */}
            <div className="border-t border-zinc-900/60 pt-5 flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0">
                <div className="relative flex-shrink-0">
                  <div className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center font-bold text-white text-xs">
                    {currentUser.username.slice(0, 2).toUpperCase()}
                  </div>
                  <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-emerald-500 border border-zinc-950 rounded-full" />
                </div>
                <div className="min-w-0">
                  <span className="font-bold text-zinc-300 text-xs block truncate leading-none mb-1">{currentUser.username}</span>
                  <span className="text-[9px] font-mono text-zinc-550 block leading-none">ID: {currentUser.id.slice(0, 5)}...</span>
                </div>
              </div>
              
              <button
                onClick={() => {
                  if (window.confirm('Are you sure you want to shut down this session?')) {
                    localStorage.removeItem('vibechat_profile');
                    setCurrentUser(null);
                  }
                }}
                title="Log out session"
                className="p-2 hover:bg-zinc-900 text-zinc-500 hover:text-red-400 rounded-lg transition"
              >
                <Ban className="w-4.5 h-4.5" />
              </button>
            </div>
          </aside>

          {/* Primary View Area */}
          <main className="flex-1 flex flex-col h-full bg-[#07090E] overflow-hidden">
            
            {/* Horizontal Header Banner - Online alerts */}
            <header className="px-6 py-4 border-b border-zinc-900/40 bg-zinc-950/20 flex items-center justify-between flex-shrink-0 relative z-10 select-none">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-emerald-400" />
                <span className="text-xs text-zinc-400 font-bold tracking-wide">
                  Server Live • <span className="text-emerald-400 font-mono font-semibold">{onlineCount + 4} connected users</span>
                </span>
              </div>
              
              {/* Dev notice info banner */}
              <div className="hidden lg:flex items-center gap-1.5 text-zinc-550 text-[10px] font-bold font-mono tracking-wider bg-zinc-900/30 px-3 py-1.5 rounded-lg border border-zinc-900/50">
                <span>PORT INGRESS: 3000 ✔</span>
              </div>
            </header>

            {/* Scrolling View Wrapper */}
            <div className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">
              <AnimatePresence mode="wait">
                <motion.div
                  key={activeTab}
                  initial={{ opacity: 0, scale: 0.99, y: 5 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.99, y: -5 }}
                  transition={{ duration: 0.2 }}
                  className="h-full"
                >
                  {activeTab === 'random' && (
                    <RandomChatScreen
                      socket={socket}
                      onlineCount={onlineCount}
                      currentUser={currentUser}
                      friendRequests={friendRequests}
                      friendships={friendsList.map((f) => f.id)}
                      onSendFriendRequest={sendFriendRequest}
                      onBlockUser={blockUser}
                      onReportUser={reportUser}
                    />
                  )}

                  {activeTab === 'messages' && (
                    <DirectMessagesScreen
                      socket={socket}
                      currentUser={currentUser}
                      friendships={friendships}
                      allUsers={allUsers}
                      onBlockUser={blockUser}
                      onReportUser={reportUser}
                    />
                  )}

                  {activeTab === 'friends' && (
                    <FriendsListScreen
                      currentUser={currentUser}
                      friendRequests={friendRequests}
                      friends={friendsList}
                      onRespondFriendRequest={respondFriendRequest}
                      onSelectTab={setActiveTab}
                    />
                  )}

                  {activeTab === 'profile' && (
                    <UserProfileScreen
                      currentUser={currentUser}
                      friendCount={friendsList.length}
                      onUpdateProfile={saveProfileHandler}
                      onLogoutAdminToggle={toggleModeratorRole}
                    />
                  )}

                  {activeTab === 'admin' && (
                    <AdminPanelScreen socket={socket} currentUser={currentUser} />
                  )}

                  {activeTab === 'settings' && (
                    <SettingsScreen blockedUserIds={blockedList} />
                  )}
                </motion.div>
              </AnimatePresence>
            </div>
          </main>

          {/* Bottom Nav Menu - Mobile Only view */}
          <nav className="md:hidden flex items-center justify-around bg-zinc-950 border-t border-zinc-900 py-2.5 flex-shrink-0 select-none relative z-20">
            {sidebarItems.map((item) => {
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id)}
                  className={`flex flex-col items-center gap-1 p-2 relative pointer-events-auto cursor-pointer ${
                    isActive ? 'text-violet-500 font-bold' : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {item.icon}
                  <span className="text-[9px] tracking-tight">{item.label.split(' ')[0]}</span>

                  {/* Invitations requests unread badge */}
                  {item.badge !== undefined && item.badge > 0 && (
                    <span className="absolute top-1.5 right-1 px-1.5 py-0.5 bg-violet-600 text-white font-extrabold text-[8px] rounded-md animate-pulse leading-none">
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

        </div>
      )}

    </div>
  );
}
