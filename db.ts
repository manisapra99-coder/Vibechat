import fs from 'fs';
import path from 'path';
import { UserProfile, Message, FriendRequest, Friendship, Block, Report } from '../types';

interface DBState {
  users: Record<string, UserProfile>;
  messages: Message[];
  friendRequests: FriendRequest[];
  friendships: Friendship[];
  blocks: Block[];
  reports: Report[];
}

const DB_FILE_PATH = path.join(process.cwd(), 'vibechat-db.json');

class JSONDatabase {
  private state: DBState = {
    users: {},
    messages: [],
    friendRequests: [],
    friendships: [],
    blocks: [],
    reports: [],
  };

  constructor() {
    this.load();
    // Bootstrap initial admin or mock users for rich environment experience
    this.bootstrapIfNeeded();
  }

  private load() {
    try {
      if (fs.existsSync(DB_FILE_PATH)) {
        const fileContent = fs.readFileSync(DB_FILE_PATH, 'utf-8');
        const parsed = JSON.parse(fileContent);
        this.state = {
          users: parsed.users || {},
          messages: parsed.messages || [],
          friendRequests: parsed.friendRequests || [],
          friendships: parsed.friendships || [],
          blocks: parsed.blocks || [],
          reports: parsed.reports || [],
        };
        console.log(`Database loaded successfully from ${DB_FILE_PATH}. Users: ${Object.keys(this.state.users).length}`);
      } else {
        this.save();
      }
    } catch (e) {
      console.error('Error loading database, initializing blank state:', e);
    }
  }

  public save() {
    try {
      fs.writeFileSync(DB_FILE_PATH, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (e) {
      console.error('Error saving database:', e);
    }
  }

  private bootstrapIfNeeded() {
    // Check if there are users, if not, create some seed users with profiles to populate our random chat / DM experiences
    if (Object.keys(this.state.users).length === 0) {
      const seedUsers: UserProfile[] = [
        {
          id: 'seed_admin',
          username: 'VibeModerator',
          bio: 'Official VibeChat Moderator. Keep our community clean and welcoming! 🌿',
          interests: ['Admin', 'Safety', 'Vibes', 'Chatting'],
          avatarIndex: 5,
          isOnline: false,
          lastActive: Date.now(),
          isAdmin: true,
        },
        {
          id: 'seed_1',
          username: 'neon_rider',
          bio: 'Midnight coder, synthwave enjoyer, and competitive coffee drinker. Send me a high-five!',
          interests: ['Music', 'Coding', 'Synthwave', 'Gaming'],
          avatarIndex: 1,
          isOnline: true,
          lastActive: Date.now(),
        },
        {
          id: 'seed_2',
          username: 'manga_bloom',
          bio: 'Anime enthusiast and aspiring digital artist. Currently reading far too many stories at once ✨',
          interests: ['Anime', 'Art', 'Reading', 'Drawing'],
          avatarIndex: 2,
          isOnline: true,
          lastActive: Date.now(),
        },
        {
          id: 'seed_3',
          username: 'chef_gabriel',
          bio: 'Food lover, experimental home cook, and hiking enthusiast. Let\'s talk about recipes!',
          interests: ['Cooking', 'Outdoors', 'Food', 'Travel'],
          avatarIndex: 3,
          isOnline: true,
          lastActive: Date.now(),
        },
        {
          id: 'seed_4',
          username: 'gravity_zero',
          bio: 'Skateboarder, amateur astronomer, and indie game dev. Looking for casual chats!',
          interests: ['Skate', 'Space', 'Indie', 'Gaming'],
          avatarIndex: 4,
          isOnline: true,
          lastActive: Date.now(),
        }
      ];

      seedUsers.forEach(u => {
        this.state.users[u.id] = u;
      });

      // Bootstrap a friend request and friendship between seed 1 and seed 2
      this.state.friendships.push({
        id: 'friend_seed_1_2',
        users: ['seed_1', 'seed_2'],
        createdAt: Date.now(),
      });

      // Bootstrap some chat messages
      this.state.messages.push({
        id: 'msg_seed_1',
        roomId: 'dm:friend_seed_1_2',
        senderId: 'seed_1',
        senderName: 'neon_rider',
        content: 'Hey there! Loved your latest art post!',
        timestamp: Date.now() - 3600000,
      });

      this.state.messages.push({
        id: 'msg_seed_2',
        roomId: 'dm:friend_seed_1_2',
        senderId: 'seed_2',
        senderName: 'manga_bloom',
        content: 'Oh! Thank you so much! I really appreciate it 💖',
        timestamp: Date.now() - 3500000,
      });

      this.save();
    }
  }

  // User methods
  getUser(id: string): UserProfile | undefined {
    return this.state.users[id];
  }

  getUsers(): UserProfile[] {
    return Object.values(this.state.users);
  }

  saveUser(user: UserProfile) {
    this.state.users[user.id] = { ...user, lastActive: Date.now() };
    this.save();
  }

  banUser(userId: string, ban: boolean) {
    if (this.state.users[userId]) {
      this.state.users[userId].isBanned = ban;
      this.save();
    }
  }

  // Messages
  addMessage(message: Message) {
    this.state.messages.push(message);
    this.save();
    return message;
  }

  getMessagesForRoom(roomId: string): Message[] {
    return this.state.messages.filter(m => m.roomId === roomId);
  }

  // Friend Requests
  getFriendRequests(userId: string): FriendRequest[] {
    return this.state.friendRequests.filter(
      r => r.senderId === userId || r.receiverId === userId
    );
  }

  getFriendRequest(id: string): FriendRequest | undefined {
    return this.state.friendRequests.find(r => r.id === id);
  }

  addFriendRequest(req: FriendRequest) {
    // Check if an existing one is pending or active
    const exists = this.state.friendRequests.some(
      r => ((r.senderId === req.senderId && r.receiverId === req.receiverId) ||
            (r.senderId === req.receiverId && r.receiverId === req.senderId)) &&
           r.status === 'pending'
    );
    if (exists) return null;

    this.state.friendRequests.push(req);
    this.save();
    return req;
  }

  updateFriendRequestStatus(id: string, status: 'accepted' | 'rejected') {
    const req = this.state.friendRequests.find(r => r.id === id);
    if (req) {
      req.status = status;
      if (status === 'accepted') {
        // Create actual friendship
        const friendshipId = `f_${req.senderId}_${req.receiverId}`;
        this.addFriendship({
          id: friendshipId,
          users: [req.senderId, req.receiverId],
          createdAt: Date.now(),
        });
      }
      this.save();
      return req;
    }
    return null;
  }

  // Friendships
  getFriendships(userId: string): Friendship[] {
    return this.state.friendships.filter(f => f.users.includes(userId));
  }

  addFriendship(friendship: Friendship) {
    const exists = this.state.friendships.some(
      f => f.users.includes(friendship.users[0]) && f.users.includes(friendship.users[1])
    );
    if (!exists) {
      this.state.friendships.push(friendship);
      this.save();
    }
  }

  removeFriendship(userId: string, friendId: string) {
    this.state.friendships = this.state.friendships.filter(
      f => !(f.users.includes(userId) && f.users.includes(friendId))
    );
    this.save();
  }

  // Blocks
  addBlock(blockerId: string, blockedId: string) {
    const id = `b_${blockerId}_${blockedId}`;
    const exists = this.state.blocks.some(b => b.blockerId === blockerId && b.blockedId === blockedId);
    if (!exists) {
      this.state.blocks.push({ id, blockerId, blockedId, createdAt: Date.now() });
      this.save();
    }
  }

  getBlocksForUser(userId: string): string[] {
    return this.state.blocks
      .filter(b => b.blockerId === userId)
      .map(b => b.blockedId);
  }

  isBlocked(userA: string, userB: string): boolean {
    return this.state.blocks.some(
      b => (b.blockerId === userA && b.blockedId === userB) ||
           (b.blockerId === userB && b.blockedId === userA)
    );
  }

  // Reports
  addReport(report: Report) {
    this.state.reports.push(report);
    this.save();
  }

  getReports(): Report[] {
    return this.state.reports;
  }

  resolveReport(id: string) {
    const r = this.state.reports.find(item => item.id === id);
    if (r) {
      r.resolved = true;
      this.save();
    }
  }
}

export const dbService = new JSONDatabase();
