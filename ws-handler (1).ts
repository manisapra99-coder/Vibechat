import { WebSocket } from 'ws';
import { dbService } from './db';
import { generateBotResponse, generateIcebreaker } from './gemini';
import { UserProfile, Message, SocketMessage, ServerMessage, FriendRequest, Friendship } from '../types';

interface BotMatchSession {
  roomId: string;
  userId: string;
  botId: string;
  messages: Message[];
}

const activeClients = new Map<string, WebSocket>(); // userId -> WS
const matchmakingQueue: string[] = []; // userIds
const activeBotMatches = new Map<string, BotMatchSession>(); // roomId -> session
const humanMatches = new Map<string, { user1Id: string; user2Id: string }>(); // roomId -> match

// Bad words filter list
const SHADOW_LANG = ['fuck', 'shit', 'asshole', 'bitch', 'bastard', 'cunt', 'dick', 'cocksucker', 'motherfucker'];

function censorText(text: string): string {
  let censored = text;
  SHADOW_LANG.forEach(word => {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    censored = censored.replace(regex, '*'.repeat(word.length));
  });
  return censored;
}

export function handleWSConnection(ws: WebSocket) {
  let currentUserId: string | null = null;
  let botMatchTimer: NodeJS.Timeout | null = null;

  // Helper helper to send packets securely
  const send = (packet: ServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(packet));
    }
  };

  const broadcastAllUsers = () => {
    const list = dbService.getUsers().map(u => ({
      ...u,
      isOnline: activeClients.has(u.id) || u.id.startsWith('seed_'),
    }));
    send({ type: 'users_update', users: list });
    // Broadcast to other clients
    activeClients.forEach((client, id) => {
      if (id !== currentUserId) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'users_update', users: list }));
        }
      }
    });
  };

  ws.on('message', async (data: string) => {
    try {
      const msg: SocketMessage = JSON.parse(data.toString());

      switch (msg.type) {
        case 'auth': {
          // In authentic mode, if the user doesn't have an ID, we register them as Guest or they provide an exact profile
          let user = msg.user;
          if (!user) {
            user = {
              id: msg.token,
              username: `Guest_${msg.token.slice(0, 5)}`,
              bio: 'New VibeChat User 👋 Feel free to chat!',
              interests: ['Vibes', 'Chatting'],
              avatarIndex: Math.floor(Math.random() * 8),
              isOnline: true,
              lastActive: Date.now(),
            };
          }

          currentUserId = user.id;
          user.isOnline = true;
          user.lastActive = Date.now();
          dbService.saveUser(user);

          activeClients.set(user.id, ws);
          console.log(`User registered: ${user.username} (${user.id})`);

          // Send confirmation
          const allUsers = dbService.getUsers().map(u => ({
            ...u,
            isOnline: activeClients.has(u.id) || u.id.startsWith('seed_'),
          }));

          send({ type: 'auth_success', user, allUsers });
          broadcastAllUsers();
          break;
        }

        case 'profile_update': {
          if (!currentUserId) return;
          const updatedUser = { ...msg.user, id: currentUserId, isOnline: true, lastActive: Date.now() };
          dbService.saveUser(updatedUser);
          send({ type: 'auth_success', user: updatedUser, allUsers: dbService.getUsers() });
          broadcastAllUsers();
          break;
        }

        case 'join_matchmaker': {
          if (!currentUserId) return;
          // Clear any dynamic states first
          leaveQueueAndReset();

          const clientProfile = dbService.getUser(currentUserId);
          if (!clientProfile) return;

          console.log(`${clientProfile.username} joined matchmaking queue.`);

          // Check if there is another human user in the queue
          const opponentId = matchmakingQueue.find(id => id !== currentUserId && !dbService.isBlocked(currentUserId!, id));
          if (opponentId) {
            // Remove opponent from queue
            const index = matchmakingQueue.indexOf(opponentId);
            if (index > -1) matchmakingQueue.splice(index, 1);

            // Match made! Create Room ID
            const roomId = `match:room_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            humanMatches.set(roomId, { user1Id: currentUserId, user2Id: opponentId });

            const opponentProfile = dbService.getUser(opponentId);
            const userProfile = dbService.getUser(currentUserId);

            // Notify both human users
            const opponentWs = activeClients.get(opponentId);
            if (opponentWs && opponentWs.readyState === WebSocket.OPEN) {
              opponentWs.send(
                JSON.stringify({
                  type: 'matchmaking_status',
                  status: 'matched',
                  opponent: userProfile,
                  roomId,
                })
              );
            }

            send({
              type: 'matchmaking_status',
              status: 'matched',
              opponent: opponentProfile,
              roomId,
            });

            console.log(`Human Match Created! ${clientProfile.username} <--> ${opponentProfile?.username}`);
          } else {
            // Put in queue
            matchmakingQueue.push(currentUserId);
            send({ type: 'matchmaking_status', status: 'searching' });

            // Start Bot Match timer to simulate OmeTV active lobby seamlessly when testing alone
            botMatchTimer = setTimeout(async () => {
              // Ensure we are still in matchmaking queue
              const qIndex = matchmakingQueue.indexOf(currentUserId!);
              if (qIndex > -1) {
                matchmakingQueue.splice(qIndex, 1);

                // Select a random seed bot the user hasn't blocked
                const blockedList = dbService.getBlocksForUser(currentUserId!);
                const bots = dbService.getUsers().filter(u => u.id.startsWith('seed_') && !blockedList.includes(u.id));
                if (bots.length === 0) {
                  send({ type: 'matchmaking_status', status: 'searching' });
                  return;
                }

                const bot = bots[Math.floor(Math.random() * bots.length)];
                const roomId = `match:bot_${Date.now()}_${currentUserId}`;

                activeBotMatches.set(roomId, {
                  roomId,
                  userId: currentUserId!,
                  botId: bot.id,
                  messages: [],
                });

                send({
                  type: 'matchmaking_status',
                  status: 'matched',
                  opponent: bot,
                  roomId,
                });

                console.log(`Bot Match Created for lonely user! ${clientProfile.username} <--> Bot ${bot.username}`);

                // Send bot typing indicator and an authentic icebreaker after a brief delay
                setTimeout(() => {
                  send({ type: 'typing_status', roomId, isTyping: true, userId: bot.id });
                }, 1000);

                setTimeout(async () => {
                  const icebreaker = await generateIcebreaker(bot, clientProfile);
                  const botMsg: Message = {
                    id: `bot_msg_${Date.now()}`,
                    roomId,
                    senderId: bot.id,
                    senderName: bot.username,
                    content: censorText(icebreaker),
                    timestamp: Date.now(),
                  };

                  // Add to bot match storage
                  const session = activeBotMatches.get(roomId);
                  if (session) {
                    session.messages.push(botMsg);
                  }

                  send({ type: 'typing_status', roomId, isTyping: false, userId: bot.id });
                  send({ type: 'message_received', message: botMsg });
                }, 2800);
              }
            }, 2500); // 2.5 seconds waiting delay
          }
          break;
        }

        case 'leave_matchmaker': {
          leaveQueueAndReset();
          send({ type: 'matchmaking_status', status: 'idle' });
          break;
        }

        case 'skip_match': {
          if (!currentUserId) return;
          console.log(`User ${currentUserId} matches skipped. Seeking reconnection.`);
          leaveQueueAndReset();
          // Automatically trigger matchmaking search on skip
          ws.emit('message', JSON.stringify({ type: 'join_matchmaker' }));
          break;
        }

        case 'send_message': {
          if (!currentUserId) return;
          const userProfile = dbService.getUser(currentUserId);
          if (!userProfile) return;

          const censoredContent = censorText(msg.content);

          const clientMsg: Message = {
            id: `msg_${Date.now()}`,
            roomId: msg.roomId,
            senderId: currentUserId,
            senderName: userProfile.username,
            content: censoredContent,
            timestamp: Date.now(),
          };

          // Check if this is a human match room or bot match room or permanent DM
          if (msg.roomId.includes('match:bot_')) {
            const session = activeBotMatches.get(msg.roomId);
            if (session) {
              session.messages.push(clientMsg);
              // Echo message back to sender
              send({ type: 'message_received', message: clientMsg });

              // Handle bot response with Gemini AI
              const botProfile = dbService.getUser(session.botId);
              if (botProfile) {
                // Set typing
                setTimeout(() => {
                  send({ type: 'typing_status', roomId: msg.roomId, isTyping: true, userId: botProfile.id });
                }, 600);

                setTimeout(async () => {
                  const replyText = await generateBotResponse(botProfile, session.messages, userProfile, true);
                  const botReply: Message = {
                    id: `bot_msg_${Date.now()}`,
                    roomId: msg.roomId,
                    senderId: botProfile.id,
                    senderName: botProfile.username,
                    content: censorText(replyText),
                    timestamp: Date.now(),
                  };

                  session.messages.push(botReply);

                  send({ type: 'typing_status', roomId: msg.roomId, isTyping: false, userId: botProfile.id });
                  send({ type: 'message_received', message: botReply });
                }, 2200);
              }
            }
          } else if (msg.roomId.includes('match:room_')) {
            const match = humanMatches.get(msg.roomId);
            if (match) {
              const recipientId = match.user1Id === currentUserId ? match.user2Id : match.user1Id;
              const recipientWs = activeClients.get(recipientId);

              // Send to recipient
              if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
                recipientWs.send(JSON.stringify({ type: 'message_received', message: clientMsg }));
              }
              // Send back to initiator
              send({ type: 'message_received', message: clientMsg });
            }
          } else if (msg.roomId.startsWith('dm:')) {
            // Permanent DM session!
            dbService.addMessage(clientMsg);
            send({ type: 'message_received', message: clientMsg });

            // Send to friendship partner
            const isBotMatch = msg.roomId.includes('_seed_') || msg.roomId.includes('seed_');
            if (isBotMatch) {
              // Extract bot ID
              const botId = msg.roomId.split('_').find(id => id.startsWith('seed_')) || '';
              const botProfile = dbService.getUser(botId);
              if (botProfile) {
                // Set typing status
                setTimeout(() => {
                  send({ type: 'typing_status', roomId: msg.roomId, isTyping: true, userId: botId });
                }, 800);

                setTimeout(async () => {
                  const history = dbService.getMessagesForRoom(msg.roomId);
                  const replyText = await generateBotResponse(botProfile, history, userProfile, false);
                  const botReply: Message = {
                    id: `bot_msg_${Date.now()}`,
                    roomId: msg.roomId,
                    senderId: botId,
                    senderName: botProfile.username,
                    content: censorText(replyText),
                    timestamp: Date.now(),
                  };

                  dbService.addMessage(botReply);

                  send({ type: 'typing_status', roomId: msg.roomId, isTyping: false, userId: botId });
                  send({ type: 'message_received', message: botReply });
                }, 2400);
              }
            } else {
              // Human friendship partner
              const friendshipId = msg.roomId.replace('dm:', '');
              const friendships = dbService.getFriendships(currentUserId);
              const friendship = friendships.find(f => f.id === friendshipId);
              if (friendship) {
                const recipientId = friendship.users.find(id => id !== currentUserId) || '';
                const recipientWs = activeClients.get(recipientId);
                if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
                  recipientWs.send(JSON.stringify({ type: 'message_received', message: clientMsg }));
                }
              }
            }
          }
          break;
        }

        case 'typing': {
          if (!currentUserId) return;
          // Forward states
          if (msg.roomId.includes('match:room_')) {
            const match = humanMatches.get(msg.roomId);
            if (match) {
              const recipientId = match.user1Id === currentUserId ? match.user2Id : match.user1Id;
              const remoteWs = activeClients.get(recipientId);
              if (remoteWs && remoteWs.readyState === WebSocket.OPEN) {
                remoteWs.send(JSON.stringify({ type: 'typing_status', roomId: msg.roomId, isTyping: msg.isTyping, userId: currentUserId }));
              }
            }
          } else if (msg.roomId.startsWith('dm:')) {
            const friendshipId = msg.roomId.replace('dm:', '');
            const friendships = dbService.getFriendships(currentUserId);
            const friendship = friendships.find(f => f.id === friendshipId);
            if (friendship) {
              const recipientId = friendship.users.find(id => id !== currentUserId) || '';
              const remoteWs = activeClients.get(recipientId);
              if (remoteWs && remoteWs.readyState === WebSocket.OPEN) {
                remoteWs.send(JSON.stringify({ type: 'typing_status', roomId: msg.roomId, isTyping: msg.isTyping, userId: currentUserId }));
              }
            }
          }
          break;
        }

        case 'friend_request_send': {
          if (!currentUserId) return;
          const user = dbService.getUser(currentUserId);
          if (!user) return;

          const reqId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
          const pendingReq: FriendRequest = {
            id: reqId,
            senderId: currentUserId,
            receiverId: msg.receiverId,
            status: 'pending',
            createdAt: Date.now(),
          };

          const addedReq = dbService.addFriendRequest(pendingReq);
          if (!addedReq) {
            send({ type: 'error', message: 'Friend request already exists or pending.' });
            return;
          }

          // Send confirmation back
          send({ type: 'friend_request_update', request: addedReq });

          // Check if receiver is a simulated seed bot
          if (msg.receiverId.startsWith('seed_')) {
            const bot = dbService.getUser(msg.receiverId);
            console.log(`User ${user.username} sent friend request to simulated Bot ${bot?.username}. Accepting after realistic thinking delay.`);

            setTimeout(() => {
              // Accept request!
              const accepted = dbService.updateFriendRequestStatus(reqId, 'accepted');
              if (accepted) {
                send({ type: 'friend_request_update', request: accepted });

                // Construct and emit friendship
                const friendshipId = `f_${currentUserId}_${msg.receiverId}`;
                const friendship: Friendship = {
                  id: friendshipId,
                  users: [currentUserId!, msg.receiverId],
                  createdAt: Date.now(),
                };
                send({
                  type: 'friendship_created',
                  friendship,
                  friend: bot!,
                });
              }
            }, 1500);
          } else {
            // Live human receiver
            const recipientWs = activeClients.get(msg.receiverId);
            if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
              recipientWs.send(
                JSON.stringify({
                  type: 'friend_request_received',
                  request: addedReq,
                  sender: user,
                })
              );
            }
          }
          break;
        }

        case 'friend_request_respond': {
          if (!currentUserId) return;
          const status = msg.accept ? 'accepted' : 'rejected';
          const updated = dbService.updateFriendRequestStatus(msg.requestId, status);
          if (updated) {
            send({ type: 'friend_request_update', request: updated });

            // Notify sender
            const senderWs = activeClients.get(updated.senderId);
            if (senderWs && senderWs.readyState === WebSocket.OPEN) {
              senderWs.send(JSON.stringify({ type: 'friend_request_update', request: updated }));

              if (status === 'accepted') {
                const userProfile = dbService.getUser(currentUserId);
                const senderProfile = dbService.getUser(updated.senderId);
                const friendshipId = `f_${updated.senderId}_${currentUserId}`;
                const friendship: Friendship = { id: friendshipId, users: [updated.senderId, currentUserId], createdAt: Date.now() };

                senderWs.send(
                  JSON.stringify({
                    type: 'friendship_created',
                    friendship,
                    friend: userProfile,
                  })
                );

                send({
                  type: 'friendship_created',
                  friendship,
                  friend: senderProfile,
                });
              }
            }
          }
          break;
        }

        case 'block_user': {
          if (!currentUserId) return;
          dbService.addBlock(currentUserId, msg.userId);
          // Auto remove friendships
          dbService.removeFriendship(currentUserId, msg.userId);

          // Disconnect active chats
          leaveQueueAndReset();

          send({ type: 'blocked_list', list: dbService.getBlocksForUser(currentUserId) });
          // Force update offline
          const recipientWs = activeClients.get(msg.userId);
          if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
            recipientWs.send(JSON.stringify({ type: 'opponent_left', message: 'You have been disconnected.' }));
          }
          broadcastAllUsers();
          break;
        }

        case 'report_user': {
          if (!currentUserId) return;
          const newReport = {
            id: `rep_${Date.now()}`,
            reporterId: currentUserId,
            reportedId: msg.userId,
            reason: msg.reason,
            timestamp: Date.now(),
            snippet: msg.snippet || '',
            resolved: false,
          };
          dbService.addReport(newReport);
          send({ type: 'error', message: 'Report submitted. Our moderation team will review this shortly!' });
          break;
        }

        case 'admin_fetch': {
          if (!currentUserId) return;
          const user = dbService.getUser(currentUserId);
          if (user?.isAdmin) {
            const reports = dbService.getReports();
            const allUsers = dbService.getUsers().map(u => ({
              ...u,
              isOnline: activeClients.has(u.id) || u.id.startsWith('seed_'),
            }));
            send({ type: 'admin_data', reports, users: allUsers });
          }
          break;
        }

        case 'admin_ban': {
          if (!currentUserId) return;
          const adminUser = dbService.getUser(currentUserId);
          if (adminUser?.isAdmin) {
            dbService.banUser(msg.userId, msg.ban);
            console.log(`ADMIN ACTION: Ban status changed for ${msg.userId} to ${msg.ban}`);

            const targetWs = activeClients.get(msg.userId);
            if (targetWs && msg.ban) {
              targetWs.send(JSON.stringify({ type: 'banned' }));
              targetWs.close();
            }

            // Refresh report panel
            const reports = dbService.getReports();
            const allUsers = dbService.getUsers().map(u => ({
              ...u,
              isOnline: activeClients.has(u.id) || u.id.startsWith('seed_'),
            }));
            send({ type: 'admin_data', reports, users: allUsers });
            broadcastAllUsers();
          }
          break;
        }
      }
    } catch (e) {
      console.error('Error handling WebSocket message:', e);
    }
  });

  ws.on('close', () => {
    leaveQueueAndReset();
    if (currentUserId) {
      activeClients.delete(currentUserId);
      console.log(`User offline: ${currentUserId}`);
      broadcastAllUsers();
    }
  });

  // Client cleanup helpers
  function leaveQueueAndReset() {
    if (botMatchTimer) {
      clearTimeout(botMatchTimer);
      botMatchTimer = null;
    }

    if (!currentUserId) return;

    // Remove from matching lobby
    const qIndex = matchmakingQueue.indexOf(currentUserId);
    if (qIndex > -1) {
      matchmakingQueue.splice(qIndex, 1);
    }

    // Clean up active bot mathches
    activeBotMatches.forEach((session, roomId) => {
      if (session.userId === currentUserId || session.botId === currentUserId) {
        activeBotMatches.delete(roomId);
        console.log(`Bot Match Disbanded: ${roomId}`);
      }
    });

    // Clean up human match rooms and notify opponent
    humanMatches.forEach((match, roomId) => {
      if (match.user1Id === currentUserId || match.user2Id === currentUserId) {
        const opponentId = match.user1Id === currentUserId ? match.user2Id : match.user1Id;
        const opponentWs = activeClients.get(opponentId);
        if (opponentWs && opponentWs.readyState === WebSocket.OPEN) {
          opponentWs.send(JSON.stringify({ type: 'opponent_left', message: 'Your chatting partner has skipped or left.' }));
        }
        humanMatches.delete(roomId);
        console.log(`Human Match Disbanded: ${roomId}`);
      }
    });
  }
}
