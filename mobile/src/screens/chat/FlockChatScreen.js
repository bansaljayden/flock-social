import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/Feather';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useSocket } from '../../context/SocketContext';
import { getMessages, sendMessage as apiSendMessage, getBlockedUsers } from '../../services/api';
import {
  joinFlock,
  leaveFlock,
  sendMessage as socketSendMessage,
  startTyping,
  stopTyping,
  onNewMessage,
  onUserTyping,
  onUserStoppedTyping,
} from '../../services/socket';
import ModerationMenu from '../../components/common/ModerationMenu';

// Phase 2 minimum: text-only chat with real-time delivery + typing indicator.
// Polish pass adds: image messages, emoji reactions, venue cards in chat,
// inline budget + bill split widgets, voting cards.
//
// FlatList is `inverted` so messages list bottom-up (newest near keyboard).
// We store messages newest-first so the inverted list renders correctly.

export default function FlockChatScreen({ route, navigation }) {
  const { colors, typography, screenPadding, radius } = useTheme();
  const { user } = useAuth();
  const { connected } = useSocket();

  const flockId = route?.params?.flockId;
  const flockName = route?.params?.flockName || 'Flock';

  const [messages, setMessages] = useState([]); // newest first
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [typingUsers, setTypingUsers] = useState([]); // [{ userId, name }]
  const [modTarget, setModTarget] = useState(null); // report/block target
  const typingTimerRef = useRef(null);
  const blockedRef = useRef(new Set()); // ids I've blocked — filter their live socket messages

  // Initial load
  useEffect(() => {
    if (!flockId) return;
    let cancelled = false;
    getMessages(flockId)
      .then((data) => {
        if (cancelled) return;
        const msgs = data?.messages || [];
        // Backend returns oldest-first; reverse for inverted FlatList
        setMessages([...msgs].reverse());
      })
      .catch((e) => console.warn('getMessages failed:', e.message));
    return () => { cancelled = true; };
  }, [flockId]);

  // Load who I've blocked so live socket messages from them are filtered too
  // (the REST read filters server-side; this keeps the real-time push consistent).
  useEffect(() => {
    getBlockedUsers()
      .then((d) => { blockedRef.current = new Set((d?.blocked || []).map((b) => b.user_id)); })
      .catch(() => {});
  }, []);

  // Socket: join flock room, listen for messages + typing
  useEffect(() => {
    if (!flockId) return;
    joinFlock(flockId);

    const offNew = onNewMessage((msg) => {
      if (msg?.flock_id !== flockId) return;
      if (blockedRef.current.has(msg.sender_id)) return; // mutual invisibility on the live socket
      setMessages((cur) => [msg, ...cur]);
    });
    const offTypingStart = onUserTyping((d) => {
      if (d?.flockId !== flockId || d?.userId === user?.id) return;
      setTypingUsers((cur) => cur.find((u) => u.userId === d.userId) ? cur : [...cur, { userId: d.userId, name: d.name }]);
    });
    const offTypingStop = onUserStoppedTyping((d) => {
      if (d?.flockId !== flockId) return;
      setTypingUsers((cur) => cur.filter((u) => u.userId !== d.userId));
    });

    return () => {
      offNew && offNew();
      offTypingStart && offTypingStart();
      offTypingStop && offTypingStop();
      leaveFlock(flockId);
    };
  }, [flockId, user?.id]);

  const handleChangeDraft = (text) => {
    setDraft(text);
    if (!flockId) return;
    startTyping(flockId);
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => stopTyping(flockId), 2200);
  };

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setDraft('');
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    stopTyping(flockId);
    try {
      // Optimistic message — replaced by socket-driven new_message event
      const tempId = `tmp-${Date.now()}`;
      const optimistic = {
        id: tempId,
        flock_id: flockId,
        sender_id: user?.id,
        sender_name: user?.name,
        content: text,
        message_type: 'text',
        created_at: new Date().toISOString(),
        _optimistic: true,
      };
      setMessages((cur) => [optimistic, ...cur]);
      // Prefer socket emit (real-time). REST as fallback if socket isn't connected.
      if (connected) {
        socketSendMessage(flockId, text);
      } else {
        await apiSendMessage(flockId, text);
      }
    } catch (e) {
      Alert.alert('Send failed', e.message);
    } finally {
      setSending(false);
    }
  }, [draft, sending, flockId, user?.id, user?.name, connected]);

  const renderMessage = ({ item }) => {
    const mine = item.sender_id === user?.id;
    const bubbleStyle = [
      styles.bubble,
      {
        backgroundColor: mine ? colors.teal : colors.msgReceivedBg,
        borderBottomRightRadius: mine ? 4 : 16,
        borderBottomLeftRadius: mine ? 16 : 4,
      },
    ];
    return (
      <View style={[styles.row, { justifyContent: mine ? 'flex-end' : 'flex-start' }]}>
        <View style={{ maxWidth: '78%' }}>
          {!mine && (
            <Text style={[typography.label, { color: colors.textTertiary, marginLeft: 12, marginBottom: 2 }]}>
              {item.sender_name}
            </Text>
          )}
          <TouchableOpacity
            activeOpacity={mine ? 1 : 0.85}
            onLongPress={mine ? undefined : () => setModTarget({ userId: item.sender_id, name: item.sender_name, contentType: 'flock_message', contentId: item.id })}
            delayLongPress={300}
            style={bubbleStyle}
          >
            <Text style={[typography.body, { color: mine ? 'white' : colors.msgReceivedText }]}>
              {item.content || item.message_text}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bgPrimary }]} edges={['top', 'bottom']}>
      <View style={[styles.headerBar, { paddingHorizontal: screenPadding.default, borderBottomColor: colors.borderSubtle }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
          <Icon name="chevron-left" size={26} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={[typography.heading4, { color: colors.textPrimary }]} numberOfLines={1}>{flockName}</Text>
          {!!typingUsers.length && (
            <Text style={[typography.caption, { color: colors.textTertiary }]}>
              {typingUsers[0].name || 'Someone'}{typingUsers.length > 1 ? ` and ${typingUsers.length - 1} other${typingUsers.length > 2 ? 's' : ''}` : ''} typing…
            </Text>
          )}
        </View>
        <TouchableOpacity
          onPress={() => navigation.navigate('FlockDetail', { flockId })}
          style={styles.headerBtn}
        >
          <Icon name="info" size={20} color={colors.textPrimary} />
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }} keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}>
        <FlatList
          data={messages}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderMessage}
          inverted
          contentContainerStyle={{ padding: screenPadding.default, paddingBottom: 8 }}
          keyboardShouldPersistTaps="handled"
        />

        <View style={[styles.composer, { backgroundColor: colors.bgPrimary, borderTopColor: colors.borderSubtle }]}>
          <TextInput
            value={draft}
            onChangeText={handleChangeDraft}
            placeholder="Message"
            placeholderTextColor={colors.textTertiary}
            multiline
            style={[
              styles.composerInput,
              typography.body,
              { backgroundColor: colors.bgInput, color: colors.textPrimary, borderColor: colors.borderDefault, borderRadius: radius.xxl },
            ]}
          />
          <TouchableOpacity
            onPress={handleSend}
            disabled={!draft.trim() || sending}
            style={[styles.sendBtn, { backgroundColor: draft.trim() ? colors.teal : colors.toggleOff }]}
          >
            <Icon name="send" size={18} color="white" />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      <ModerationMenu
        target={modTarget}
        onClose={() => setModTarget(null)}
        onBlocked={(id) => {
          blockedRef.current.add(id);
          setMessages((cur) => cur.filter((m) => m.sender_id !== id));
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  headerBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 8, paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', marginVertical: 3 },
  bubble: { padding: 10, paddingHorizontal: 14, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  composer: {
    flexDirection: 'row', alignItems: 'flex-end',
    paddingHorizontal: 12, paddingVertical: 8, gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  composerInput: {
    flex: 1, maxHeight: 120, minHeight: 40,
    paddingHorizontal: 14, paddingVertical: 10,
    borderWidth: 1,
  },
  sendBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
});
