import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  calculateSubscriptionRevenue,
  calculateTransactionRevenue,
  calculateTotalMonthlyRevenue,
  calculateAnnualRevenue,
  calculateMonthlyProfit,
  calculateRevenuePerVenue,
  calculateBreakEven,
  formatCurrency,
  calculateProfitMargin
} from './lib/finance';

// Brand Colors
const colors = {
  navy: '#0d2847',
  navyLight: '#1a3a5c',
  navyMid: '#2d5a87',
  skyBlue: '#4a7ba7',
  cream: '#f5f0e6',
  creamDark: '#e8e0d0',
  teal: '#14B8A6',
  amber: '#F59E0B',
  red: '#EF4444',
  food: '#F97316',
  nightlife: '#1a3a5c',
  music: '#2d5a87',
  sports: '#22C55E',
};

// Shared styles
const styles = {
  phoneContainer: {
    width: '375px',
    maxWidth: '375px',
    height: '100vh',
    maxHeight: '812px',
    margin: '20px auto',
    borderRadius: '44px',
    border: `6px solid ${colors.navy}`,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: 'white',
    boxShadow: '0 25px 80px -12px rgba(0, 0, 0, 0.4), 0 10px 30px rgba(13,40,71,0.2), inset 0 1px 0 rgba(255,255,255,0.1)',
    position: 'relative',
  },
  notch: {
    height: '28px',
    backgroundColor: colors.navy,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  notchInner: {
    width: '120px',
    height: '24px',
    backgroundColor: 'black',
    borderRadius: '20px',
  },
  content: {
    flex: 1,
    overflow: 'hidden',
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
  },
  bottomNav: {
    display: 'flex',
    justifyContent: 'space-around',
    padding: '8px 4px',
    backgroundColor: 'white',
    borderTop: `1px solid ${colors.creamDark}`,
    flexShrink: 0,
  },
  navItem: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '2px',
    padding: '6px 12px',
    borderRadius: '12px',
    border: 'none',
    cursor: 'pointer',
    backgroundColor: 'transparent',
  },
  gradientButton: {
    background: `linear-gradient(135deg, ${colors.navy} 0%, ${colors.navyLight} 50%, ${colors.navyMid} 100%)`,
    color: 'white',
    border: 'none',
    borderRadius: '14px',
    padding: '14px 24px',
    fontWeight: '700',
    fontSize: '14px',
    cursor: 'pointer',
    width: '100%',
    boxShadow: '0 4px 15px rgba(13,40,71,0.3), 0 2px 4px rgba(0,0,0,0.1)',
    transition: 'transform 0.2s, box-shadow 0.2s',
    letterSpacing: '0.3px',
  },
  card: {
    backgroundColor: 'rgba(255,255,255,0.95)',
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
    borderRadius: '16px',
    padding: '14px',
    marginBottom: '10px',
    boxShadow: '0 4px 20px rgba(13,40,71,0.08), 0 1px 3px rgba(0,0,0,0.05)',
    border: '1px solid rgba(255,255,255,0.8)',
  },
  input: {
    width: '100%',
    padding: '14px 16px',
    borderRadius: '14px',
    border: `2px solid ${colors.creamDark}`,
    fontSize: '14px',
    outline: 'none',
    boxSizing: 'border-box',
    transition: 'border-color 0.2s, box-shadow 0.2s',
    backgroundColor: 'rgba(255,255,255,0.9)',
  },
};

const FlockApp = () => {
  // Navigation
  const [currentTab, setCurrentTab] = useState('home');
  const [currentScreen, setCurrentScreen] = useState('main');
  const [selectedFlockId, setSelectedFlockId] = useState(null);
  const [pickingVenueForCreate, setPickingVenueForCreate] = useState(false);
  const [selectedVenueForCreate, setSelectedVenueForCreate] = useState(null);

  // Toast
  const [toast, setToast] = useState(null);
  const showToast = useCallback((message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  // Loading & Gamification
  const [isLoading, setIsLoading] = useState(false);
  const [userXP, setUserXP] = useState(280);
  const [userLevel, setUserLevel] = useState(3);
  const [streak] = useState(5);

  const addXP = useCallback((amount) => {
    setUserXP(prev => {
      const newXP = prev + amount;
      const newLevel = Math.floor(newXP / 100) + 1;
      if (newLevel > userLevel) {
        setUserLevel(newLevel);
        showToast(`🎉 Level Up! Level ${newLevel}!`);
      }
      return newXP;
    });
  }, [userLevel, showToast]);

  // AI Assistant
  const [aiMessages, setAiMessages] = useState([
    { role: 'assistant', text: "Hey! I'm your Flock AI. Ask me about venues, crowds, or help planning! 🎉" }
  ]);
  const [aiInput, setAiInput] = useState('');
  const [aiTyping, setAiTyping] = useState(false);
  const [showAiAssistant, setShowAiAssistant] = useState(false);

  const sendAiMessage = useCallback(() => {
    if (!aiInput.trim()) return;
    const userMsg = aiInput.trim().toLowerCase();
    setAiMessages(prev => [...prev, { role: 'user', text: aiInput }]);
    setAiInput('');
    setAiTyping(true);
    setTimeout(() => {
      let response = "I can help you find venues, check crowds, or plan events!";
      if (userMsg.includes('busy') || userMsg.includes('crowd')) response = "The Blue Heron Bar is at 55% capacity. Club Nova is quiet at 40%!";
      else if (userMsg.includes('recommend')) response = "Try The Jazz Room tonight! Live jazz at 9 PM. 🎵";
      else if (userMsg.includes('food')) response = "Joe's Pizza has great late-night slices (4.5 stars)!";
      setAiMessages(prev => [...prev, { role: 'assistant', text: response }]);
      setAiTyping(false);
    }, 1500);
  }, [aiInput]);

  // Calendar
  const [calendarMonth, setCalendarMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [calendarEvents, setCalendarEvents] = useState([
    { id: 1, title: 'Friday Night Downtown', date: '2025-01-17', time: '9:00 PM', venue: 'The Blue Heron Bar', color: colors.navy, members: 4 },
    { id: 2, title: "Sarah's Birthday", date: '2025-01-18', time: '8:00 PM', venue: 'Club Nova', color: colors.navyMid, members: 6 },
  ]);
  const [showAddEvent, setShowAddEvent] = useState(false);
  const [newEventTitle, setNewEventTitle] = useState('');
  const [newEventVenue, setNewEventVenue] = useState('');

  // Stories
  const stories = [
    { id: 1, name: 'Alex', avatar: '🎸', hasNew: true },
    { id: 2, name: 'Sarah', avatar: '🎂', hasNew: true },
    { id: 3, name: 'Jordan', avatar: '⚽', hasNew: false },
    { id: 4, name: 'Taylor', avatar: '🍸', hasNew: true },
    { id: 5, name: 'Mike', avatar: '🎮', hasNew: true },
  ];

  // Activity
  const activityFeed = [
    { id: 1, user: 'Alex', action: 'created', target: 'Jazz Night', time: '5m', icon: '🎉' },
    { id: 2, user: 'Jordan', action: 'voted for', target: 'Sports Bar', time: '12m', icon: '🗳️' },
  ];

  // Flocks
  const [flocks, setFlocks] = useState([
    { id: 1, name: "Friday Night Downtown", host: "Alex", members: ['Alex', 'Sam', 'Jordan', 'Taylor'], time: "Tonight 9 PM", status: "voting", venue: "The Blue Heron Bar", cashPool: { target: 80, collected: 60, perPerson: 20, paid: ['Alex', 'Sam', 'Jordan'] }, votes: [{ venue: "The Blue Heron Bar", type: "Cocktail Bar", voters: ['Alex', 'Sam'] }, { venue: "Club Nova", type: "Nightclub", voters: ['Jordan'] }], messages: [{ id: 1, sender: 'Alex', time: '5:00 PM', text: "Ready for tonight? 🎉", reactions: ['🔥'] }] },
    { id: 2, name: "Sarah's Birthday", host: "Sarah", members: ['Sarah', 'You', 'Mike', 'Emma'], time: "Saturday 8 PM", status: "confirmed", venue: "Club Nova", cashPool: { target: 80, collected: 80, perPerson: 20, paid: ['Sarah', 'You', 'Mike', 'Emma'] }, votes: [], messages: [{ id: 1, sender: 'Sarah', time: '2:00 PM', text: "Can't wait! 🎂", reactions: ['❤️'] }] },
    { id: 3, name: "Game Day", host: "Chris", members: ['Chris', 'You', 'Dave'], time: "Sunday 4 PM", status: "voting", venue: "Sports Bar & Grill", cashPool: null, votes: [{ venue: "Sports Bar & Grill", type: "Sports Bar", voters: ['Chris', 'Dave'] }], messages: [{ id: 1, sender: 'Chris', time: '10:00 AM', text: "Big game! 🏈", reactions: [] }] }
  ]);

  // Create Flock form
  const [flockName, setFlockName] = useState('');
  const [flockDate, setFlockDate] = useState('Tonight');
  const [flockTime, setFlockTime] = useState('9 PM');
  const [flockFriends, setFlockFriends] = useState([]);
  const [flockCashPool, setFlockCashPool] = useState(false);
  const [flockAmount, setFlockAmount] = useState(20);
  const [joinCode, setJoinCode] = useState('');

  // Explore
  const [searchText, setSearchText] = useState('');
  const [category, setCategory] = useState('All');
  const [activeVenue, setActiveVenue] = useState(null);
  const [connections, setConnections] = useState([
    { id: 1, name: 'Alex M.', loc: 'The Jazz Room', interests: ['Live Music'], status: 'available', distance: '0.3 mi' },
    { id: 2, name: 'Jordan K.', loc: 'Sports Bar', interests: ['Sports'], status: 'available', distance: '0.5 mi' },
  ]);
  const [showConnectPanel, setShowConnectPanel] = useState(false);

  // Chat
  const [chatInput, setChatInput] = useState('');
  const [showChatPool, setShowChatPool] = useState(false);
  const [chatPoolAmount, setChatPoolAmount] = useState(20);
  const chatEndRef = useRef(null);
  const [isTyping, setIsTyping] = useState(false);
  const [chatSearch, setChatSearch] = useState('');
  const [showChatSearch, setShowChatSearch] = useState(false);
  const [replyingTo, setReplyingTo] = useState(null);
  const [showReactionPicker, setShowReactionPicker] = useState(null);

  // Profile
  const [profileScreen, setProfileScreen] = useState('main');
  const [profileName, setProfileName] = useState('the maintainer');
  const [profileHandle, setProfileHandle] = useState('jayden');
  const [profileBio, setProfileBio] = useState('Love exploring new places!');
  const [profilePic, setProfilePic] = useState(null);
  const [showPicModal, setShowPicModal] = useState(false);
  const [trustedContacts, setTrustedContacts] = useState(['Mom', 'Dad']);
  const [newContactName, setNewContactName] = useState('');
  const [safetyOn, setSafetyOn] = useState(true);

  // Modals
  const [showSOS, setShowSOS] = useState(false);
  const [showCheckin, setShowCheckin] = useState(false);

  // Admin Mode (for Revenue Simulator access)
  const [isAdminMode, setIsAdminMode] = useState(false);
  const [showAdminPrompt, setShowAdminPrompt] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');

  // Venue Dashboard (for venue owners)
  const [isVenueOwner, setIsVenueOwner] = useState(false);
  const [venueTier, setVenueTier] = useState('free'); // 'free', 'premium', 'pro'

  // Check URL for admin mode on mount
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('admin') === 'true') {
      setIsAdminMode(true);
    }
    if (urlParams.get('venue') === 'true') {
      setIsVenueOwner(true);
      setVenueTier(urlParams.get('tier') || 'free');
    }
  }, []);

  const allFriends = ['Alex', 'Sam', 'Jordan', 'Taylor', 'Morgan', 'Chris', 'Emma', 'Mike'];

  const allVenues = useMemo(() => [
    { id: 1, name: "Joe's Pizza", type: "Italian", category: "Food", x: 25, y: 30, crowd: 45, best: "Now", stars: 4.5, addr: '456 Oak Ave', price: '$', trending: false },
    { id: 2, name: "Taco Cantina", type: "Mexican", category: "Food", x: 48, y: 55, crowd: 30, best: "8:30 PM", stars: 4.2, addr: '789 Elm St', price: '$', trending: false },
    { id: 3, name: "The Diner", type: "American", category: "Food", x: 70, y: 38, crowd: 65, best: "Now", stars: 4.0, addr: '321 Pine Rd', price: '$$', trending: false },
    { id: 4, name: "Blue Heron Bar", type: "Cocktail Bar", category: "Nightlife", x: 30, y: 45, crowd: 55, best: "8:30 PM", stars: 4.7, addr: '123 Main St', price: '$$', trending: true },
    { id: 5, name: "Club Nova", type: "Nightclub", category: "Nightlife", x: 45, y: 62, crowd: 40, best: "10 PM", stars: 4.3, addr: '555 Party Ln', price: '$$$', trending: true },
    { id: 6, name: "Rooftop Lounge", type: "Lounge", category: "Nightlife", x: 38, y: 28, crowd: 70, best: "Now", stars: 4.8, addr: '999 Sky Dr', price: '$$$', trending: true },
    { id: 7, name: "The Jazz Room", type: "Jazz Club", category: "Live Music", x: 58, y: 35, crowd: 50, best: "9 PM", stars: 4.6, addr: '222 Music Blvd', price: '$$', trending: false },
    { id: 8, name: "Sports Bar & Grill", type: "Sports Bar", category: "Sports", x: 75, y: 25, crowd: 85, best: "Game time", stars: 4.1, addr: '444 Game Way', price: '$$', trending: false },
  ], []);

  const getFilteredVenues = useCallback(() => {
    let venues = category === 'All' ? allVenues : allVenues.filter(v => v.category === category);
    if (searchText.trim()) {
      const q = searchText.toLowerCase();
      venues = allVenues.filter(v => v.name.toLowerCase().includes(q) || v.type.toLowerCase().includes(q));
    }
    return venues;
  }, [category, searchText, allVenues]);

  const getSelectedFlock = useCallback(() => flocks.find(f => f.id === selectedFlockId) || flocks[0], [flocks, selectedFlockId]);

  const formatDateStr = (d) => d.toISOString().split('T')[0];
  const getDaysInMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const getFirstDayOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1).getDay();
  const getEventsForDate = useCallback((dateStr) => calendarEvents.filter(e => e.date === dateStr), [calendarEvents]);

  const addEventToCalendar = useCallback((title, venue, date, time, color) => {
    setCalendarEvents(prev => [...prev, { id: Date.now(), title, venue, date: typeof date === 'string' ? date : formatDateStr(date), time, color: color || colors.navy, members: 1 }]);
    showToast('📅 Added to calendar!');
  }, [showToast]);

  const addMessageToFlock = useCallback((flockId, message) => {
    setFlocks(prev => prev.map(f => f.id === flockId ? { ...f, messages: [...f.messages, message] } : f));
  }, []);

  const updateFlockVotes = useCallback((flockId, newVotes) => {
    setFlocks(prev => prev.map(f => f.id === flockId ? { ...f, votes: newVotes } : f));
  }, []);

  const makePoolPayment = useCallback((flockId) => {
    setFlocks(prev => prev.map(f => {
      if (f.id === flockId && f.cashPool && !f.cashPool.paid.includes('You')) {
        return { ...f, cashPool: { ...f.cashPool, paid: [...f.cashPool.paid, 'You'], collected: f.cashPool.collected + f.cashPool.perPerson } };
      }
      return f;
    }));
    addXP(20);
    showToast('💰 Payment sent!');
  }, [addXP, showToast]);

  // Auto-scroll chat to bottom when messages change
  const selectedFlock = flocks.find(f => f.id === selectedFlockId) || flocks[0];
  useEffect(() => {
    if (currentScreen === 'chatDetail' && chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [selectedFlock?.messages, currentScreen]);

  // Send chat message callback
  const sendChatMessage = useCallback(() => {
    if (chatInput.trim()) {
      addMessageToFlock(selectedFlockId, { id: Date.now(), sender: 'You', time: 'Now', text: chatInput, reactions: [] });
      setChatInput('');
      addXP(5);
    }
  }, [chatInput, selectedFlockId, addMessageToFlock, addXP]);

  const getCategoryColor = (cat) => {
    switch(cat) {
      case 'Food': return colors.food;
      case 'Nightlife': return colors.nightlife;
      case 'Live Music': return colors.music;
      case 'Sports': return colors.sports;
      default: return colors.navy;
    }
  };

  // Relative time formatter
  const getRelativeTime = (timeStr) => {
    if (timeStr === 'Now') return 'Just now';
    if (timeStr.includes('ago') || timeStr === 'Yesterday') return timeStr;
    const times = { '5m': '5m ago', '10m': '10m ago', '1h': '1h ago', '2h': '2h ago' };
    return times[timeStr] || timeStr;
  };

  // SVG Icon Components
  const Icons = {
    heart: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>,
    thumbsUp: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path></svg>,
    flame: (color = '#F59E0B', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke="none"><path d="M12 23c-4.97 0-9-3.58-9-8 0-3.19 2.13-6.02 5-8 0 2 1 4 3 5 0-3 2-5 4-7 1 1 2 3 2 5 2-1 3-3 3-5 2.87 1.98 5 4.81 5 8 0 4.42-4.03 8-9 8z"/></svg>,
    party: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>,
    mapPin: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>,
    calendar: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>,
    users: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>,
    shield: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>,
    sparkles: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"></path><path d="M5 19l.5 1.5L7 21l-1.5.5L5 23l-.5-1.5L3 21l1.5-.5L5 19z"></path><path d="M19 12l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5.5-1.5z"></path></svg>,
    dollar: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>,
    vote: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 12l2 2 4-4"></path><path d="M5 7c0-1.1.9-2 2-2h10a2 2 0 0 1 2 2v12H5V7z"></path><path d="M22 19H2"></path></svg>,
    pizza: (color = '#F97316', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 19h20L12 2z"></path><circle cx="12" cy="12" r="1"></circle><circle cx="9" cy="15" r="1"></circle><circle cx="15" cy="15" r="1"></circle></svg>,
    cocktail: (color = '#1a3a5c', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 22h8"></path><path d="M12 11v11"></path><path d="M3 3l18 0-6 8h-6z"></path></svg>,
    music: (color = '#2d5a87', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>,
    sports: (color = '#22C55E', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 2a15 15 0 0 0 0 20 15 15 0 0 0 0-20"></path><path d="M2 12h20"></path></svg>,
    send: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>,
    mic: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>,
    image: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>,
    search: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>,
    check: (color = 'currentColor', size = 14) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>,
    checkDouble: (color = 'currentColor', size = 14) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 6 9 17 4 12"></polyline><polyline points="22 6 13 17"></polyline></svg>,
    reply: (color = 'currentColor', size = 16) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>,
    compass: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"></polygon></svg>,
    trendingUp: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline><polyline points="17 6 23 6 23 12"></polyline></svg>,
    clock: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>,
    sun: (color = '#F59E0B', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>,
    cloud: (color = '#9ca3af', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path></svg>,
    home: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>,
    user: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>,
    wave: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"></path><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"></path><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"></path><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"></path></svg>,
    robot: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4"></path><line x1="8" y1="16" x2="8" y2="16"></line><line x1="16" y1="16" x2="16" y2="16"></line></svg>,
    logout: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>,
    camera: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>,
    x: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>,
    plus: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>,
    minus: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>,
    arrowLeft: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>,
    arrowRight: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>,
    bell: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>,
    settings: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>,
    repeat: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>,
    zap: (color = '#F59E0B', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke={color} strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>,
    activity: (color = 'currentColor', size = 18) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>,
  };

  // Add reaction to message
  const addReactionToMessage = useCallback((flockId, messageId, reaction) => {
    setFlocks(prev => prev.map(f => {
      if (f.id === flockId) {
        return {
          ...f,
          messages: f.messages.map(m => {
            if (m.id === messageId) {
              const hasReaction = m.reactions.includes(reaction);
              return { ...m, reactions: hasReaction ? m.reactions.filter(r => r !== reaction) : [...m.reactions, reaction] };
            }
            return m;
          })
        };
      }
      return f;
    }));
    setShowReactionPicker(null);
  }, []);

  // Simulate typing indicator
  const simulateTyping = useCallback(() => {
    setIsTyping(true);
    setTimeout(() => setIsTyping(false), 2000 + Math.random() * 2000);
  }, []);

  const handlePhotoUpload = useCallback((e) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => { setProfilePic(reader.result); setShowPicModal(false); showToast('📷 Photo uploaded!'); addXP(10); };
      reader.readAsDataURL(file);
    }
  }, [showToast, addXP]);

  const generateAIAvatar = useCallback(() => {
    const styles = ['adventurer', 'avataaars', 'bottts', 'personas', 'pixel-art'];
    const style = styles[Math.floor(Math.random() * styles.length)];
    const seed = Math.random().toString(36).substring(7);
    setProfilePic(`https://api.dicebear.com/7.x/${style}/svg?seed=${seed}`);
    setShowPicModal(false);
    showToast('🤖 AI Avatar generated!');
    addXP(10);
  }, [showToast, addXP]);

  // Toggle Component
  const Toggle = ({ on, onChange }) => (
    <button onClick={onChange} style={{ width: '44px', height: '24px', borderRadius: '12px', border: 'none', backgroundColor: on ? colors.teal : '#d1d5db', cursor: 'pointer', position: 'relative', transition: 'background-color 0.2s' }}>
      <div style={{ width: '20px', height: '20px', borderRadius: '10px', backgroundColor: 'white', position: 'absolute', top: '2px', left: on ? '22px' : '2px', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }} />
    </button>
  );

  // SVG Icons for navigation
  const NavIcon = ({ id, active }) => {
    const color = active ? colors.navy : '#9ca3af';
    const icons = {
      home: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>,
      explore: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"></polygon><line x1="9" y1="3" x2="9" y2="18"></line><line x1="15" y1="6" x2="15" y2="21"></line></svg>,
      calendar: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>,
      chat: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>,
      revenue: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>,
      profile: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>,
    };
    return icons[id] || null;
  };

  // Bottom Navigation (Regular users - no Revenue tab)
  const BottomNav = () => (
    <div style={{ ...styles.bottomNav, boxShadow: '0 -4px 20px rgba(0,0,0,0.05)' }}>
      {[
        { id: 'home', label: 'Home' },
        { id: 'explore', label: 'Explore' },
        { id: 'calendar', label: 'Calendar' },
        { id: 'chat', label: 'Chat' },
        { id: 'profile', label: 'Profile' },
      ].map(t => (
        <button key={t.id} onClick={() => { setCurrentTab(t.id); setCurrentScreen('main'); setProfileScreen('main'); setActiveVenue(null); setShowConnectPanel(false); }}
          style={{ ...styles.navItem, backgroundColor: currentTab === t.id ? colors.cream : 'transparent', transition: 'all 0.2s' }}>
          <NavIcon id={t.id} active={currentTab === t.id} />
          <span style={{ fontSize: '10px', fontWeight: '600', color: currentTab === t.id ? colors.navy : '#9ca3af', marginTop: '2px' }}>{t.label}</span>
        </button>
      ))}
    </div>
  );

  // Safety Button
  const SafetyButton = () => safetyOn && currentScreen === 'main' && (
    <button onClick={() => setShowSOS(true)} style={{ position: 'absolute', bottom: '70px', right: '12px', width: '48px', height: '48px', borderRadius: '24px', border: 'none', background: `linear-gradient(135deg, ${colors.red}, #f97316)`, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', boxShadow: '0 4px 12px rgba(0,0,0,0.3)', zIndex: 20 }}>
      {Icons.shield('white', 22)}
    </button>
  );

  // AI Button
  const AIButton = () => currentScreen === 'main' && currentTab === 'home' && (
    <button onClick={() => setShowAiAssistant(true)} style={{ position: 'absolute', bottom: '70px', left: '12px', width: '48px', height: '48px', borderRadius: '24px', border: 'none', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', boxShadow: '0 4px 12px rgba(0,0,0,0.3)', zIndex: 20 }}>
      {Icons.robot('white', 22)}
    </button>
  );

  // Toast
  const Toast = () => toast && (
    <div style={{ position: 'fixed', top: '40px', left: '50%', transform: 'translateX(-50%)', zIndex: 60, padding: '10px 20px', borderRadius: '20px', backgroundColor: toast.type === 'success' ? colors.teal : colors.red, color: 'white', fontSize: '14px', fontWeight: '600', boxShadow: '0 4px 12px rgba(0,0,0,0.2)' }}>
      {toast.message}
    </div>
  );

  // SOS Modal
  const SOSModal = () => showSOS && (
    <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}>
      <div style={{ backgroundColor: 'white', borderRadius: '24px', padding: '20px', width: '100%', maxWidth: '280px' }}>
        <div style={{ textAlign: 'center', marginBottom: '16px' }}>
          <div style={{ width: '64px', height: '64px', borderRadius: '32px', backgroundColor: '#fee2e2', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 8px' }}>{Icons.bell(colors.red, 32)}</div>
          <h2 style={{ fontSize: '20px', fontWeight: '900', color: colors.navy, margin: 0 }}>Emergency</h2>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <button onClick={() => { showToast('SOS sent to contacts!'); setShowSOS(false); addXP(30); }} style={{ ...styles.gradientButton, background: `linear-gradient(90deg, ${colors.red}, #f97316)`, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>{Icons.shield('white', 16)} Alert Contacts</button>
          <button onClick={() => { showToast('Location shared!'); setShowSOS(false); }} style={{ ...styles.gradientButton, background: 'white', color: colors.navy, border: `2px solid ${colors.navy}`, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>{Icons.mapPin(colors.navy, 16)} Share Location</button>
          <button onClick={() => setShowSOS(false)} style={{ background: 'none', border: 'none', color: '#9ca3af', padding: '8px', cursor: 'pointer' }}>Cancel</button>
        </div>
      </div>
    </div>
  );

  // Check-in Modal
  const CheckinModal = () => showCheckin && (
    <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}>
      <div style={{ backgroundColor: 'white', borderRadius: '24px', padding: '20px', width: '100%', maxWidth: '280px' }}>
        <div style={{ textAlign: 'center', marginBottom: '16px' }}>
          <div style={{ width: '64px', height: '64px', borderRadius: '32px', backgroundColor: colors.cream, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 8px' }}>{Icons.check(colors.teal, 32)}</div>
          <h2 style={{ fontSize: '20px', fontWeight: '900', color: colors.navy, margin: 0 }}>Check-in</h2>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <button onClick={() => { showToast('Check-in sent!'); setShowCheckin(false); addXP(30); }} style={{ ...styles.gradientButton, backgroundColor: colors.teal, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>{Icons.check('white', 16)} I'm Safe</button>
          <button onClick={() => { setShowCheckin(false); setShowSOS(true); }} style={{ ...styles.gradientButton, backgroundColor: colors.red, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>{Icons.shield('white', 16)} Need Help</button>
          <button onClick={() => setShowCheckin(false)} style={{ background: 'none', border: 'none', color: '#9ca3af', padding: '8px', cursor: 'pointer' }}>Dismiss</button>
        </div>
      </div>
    </div>
  );

  // Profile Pic Modal
  const ProfilePicModal = () => showPicModal && (
    <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}>
      <div style={{ backgroundColor: 'white', borderRadius: '24px', padding: '20px', width: '100%', maxWidth: '280px' }}>
        <h2 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: '0 0 16px', textAlign: 'center' }}>Profile Picture</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <label style={{ ...styles.gradientButton, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', cursor: 'pointer' }}>
            {Icons.camera('white', 16)} Upload Photo
            <input type="file" accept="image/*" onChange={handlePhotoUpload} style={{ display: 'none' }} />
          </label>
          <button onClick={generateAIAvatar} style={{ ...styles.gradientButton, background: 'white', color: colors.navy, border: `2px solid ${colors.navy}`, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>{Icons.robot(colors.navy, 16)} Generate AI Avatar</button>
          <button onClick={() => setShowPicModal(false)} style={{ background: 'none', border: 'none', color: '#9ca3af', padding: '8px', cursor: 'pointer' }}>Cancel</button>
        </div>
      </div>
    </div>
  );

  // Admin Password Modal
  const AdminPromptModal = () => showAdminPrompt && (
    <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}>
      <div style={{ backgroundColor: 'white', borderRadius: '24px', padding: '20px', width: '100%', maxWidth: '280px' }}>
        <div style={{ textAlign: 'center', marginBottom: '16px' }}>
          <div style={{ width: '48px', height: '48px', borderRadius: '24px', backgroundColor: colors.cream, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 8px' }}>
            {Icons.shield(colors.navy, 24)}
          </div>
          <h2 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: 0 }}>Admin Access</h2>
          <p style={{ fontSize: '12px', color: '#6b7280', margin: '4px 0 0' }}>Enter password to continue</p>
        </div>
        <input
          type="password"
          value={adminPassword}
          onChange={(e) => setAdminPassword(e.target.value)}
          placeholder="Password"
          style={{ width: '100%', padding: '12px', borderRadius: '12px', border: `1px solid ${colors.creamDark}`, fontSize: '14px', marginBottom: '12px', boxSizing: 'border-box' }}
        />
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={() => { setShowAdminPrompt(false); setAdminPassword(''); }} style={{ flex: 1, padding: '12px', borderRadius: '12px', border: '1px solid #d1d5db', backgroundColor: 'white', fontWeight: '600', cursor: 'pointer' }}>Cancel</button>
          <button onClick={() => {
            if (adminPassword === 'flock2026') {
              setIsAdminMode(true);
              setShowAdminPrompt(false);
              setAdminPassword('');
              setCurrentScreen('adminRevenue');
              showToast('Admin access granted');
            } else {
              showToast('Incorrect password', 'error');
              setAdminPassword('');
            }
          }} style={{ flex: 1, padding: '12px', borderRadius: '12px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontWeight: '600', cursor: 'pointer' }}>Access</button>
        </div>
      </div>
    </div>
  );

  // AI Assistant Modal
  const AIAssistantModal = () => {
    const suggestedQuestions = [
      { text: "What's busy right now?", icon: Icons.activity },
      { text: "Best time for Club Nova?", icon: Icons.clock },
      { text: "Recommend a bar", icon: Icons.cocktail },
      { text: "Food near me", icon: Icons.pizza },
    ];

    const quickActions = [
      { label: 'Find Venue', icon: Icons.compass, action: () => { setShowAiAssistant(false); setCurrentTab('explore'); } },
      { label: 'Start Flock', icon: Icons.users, action: () => { setShowAiAssistant(false); setCurrentScreen('create'); } },
      { label: 'Check Calendar', icon: Icons.calendar, action: () => { setShowAiAssistant(false); setCurrentTab('calendar'); } },
    ];

    return showAiAssistant && (
      <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
        <div style={{ backgroundColor: 'white', borderRadius: '24px 24px 0 0', width: '100%', height: '80%', display: 'flex', flexDirection: 'column' }}>
          {/* Header with animated AI avatar */}
          <div style={{ padding: '12px', borderBottom: '1px solid #eee', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, borderRadius: '24px 24px 0 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ position: 'relative' }}>
                <div style={{ width: '40px', height: '40px', borderRadius: '20px', background: 'linear-gradient(135deg, #4F46E5, #7C3AED)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 12px rgba(79,70,229,0.4)' }}>
                  {Icons.robot('white', 22)}
                </div>
                <div style={{ position: 'absolute', bottom: '-2px', right: '-2px', width: '14px', height: '14px', borderRadius: '7px', backgroundColor: '#22C55E', border: '2px solid white', animation: 'pulse 2s ease-in-out infinite' }} />
              </div>
              <div>
                <h2 style={{ fontSize: '15px', fontWeight: 'bold', color: 'white', margin: 0 }}>Flock AI</h2>
                <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.7)', margin: 0, display: 'flex', alignItems: 'center', gap: '4px' }}>
                  {Icons.sparkles('rgba(255,255,255,0.7)', 10)}
                  <span>Powered by AI</span>
                </p>
              </div>
            </div>
            <button onClick={() => setShowAiAssistant(false)} style={{ width: '28px', height: '28px', borderRadius: '14px', backgroundColor: 'rgba(255,255,255,0.2)', border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x('white', 16)}</button>
          </div>

          {/* Quick Actions */}
          <div style={{ padding: '10px 12px', backgroundColor: '#f9fafb', borderBottom: '1px solid #eee', display: 'flex', gap: '8px' }}>
            {quickActions.map((action, i) => (
              <button key={i} onClick={action.action} style={{ flex: 1, padding: '8px', borderRadius: '10px', border: '1px solid rgba(13,40,71,0.1)', backgroundColor: 'white', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                {action.icon(colors.navy, 16)}
                <span style={{ fontSize: '9px', fontWeight: '600', color: colors.navy }}>{action.label}</span>
              </button>
            ))}
          </div>

          {/* Messages */}
          <div style={{ flex: 1, padding: '12px', overflowY: 'auto' }}>
            {aiMessages.length === 1 && (
              <div style={{ textAlign: 'center', padding: '16px 0', marginBottom: '12px' }}>
                <div style={{ width: '60px', height: '60px', borderRadius: '30px', background: 'linear-gradient(135deg, #4F46E5, #7C3AED)', margin: '0 auto 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 8px 24px rgba(79,70,229,0.3)' }}>
                  {Icons.robot('white', 30)}
                </div>
                <h3 style={{ fontSize: '16px', fontWeight: '700', color: colors.navy, margin: '0 0 4px' }}>How can I help?</h3>
                <p style={{ fontSize: '11px', color: '#6b7280', margin: 0 }}>Ask me about venues, crowds, or planning!</p>
              </div>
            )}

            {aiMessages.map((msg, i) => (
              <div key={i} style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexDirection: msg.role === 'user' ? 'row-reverse' : 'row' }}>
                <div style={{ width: '30px', height: '30px', borderRadius: '15px', background: msg.role === 'user' ? `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})` : 'linear-gradient(135deg, #4F46E5, #7C3AED)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
                  {msg.role === 'user' ? Icons.user('white', 14) : Icons.robot('white', 14)}
                </div>
                <div style={{ maxWidth: '78%' }}>
                  <div style={{ borderRadius: '16px', padding: '10px 12px', fontSize: '13px', backgroundColor: msg.role === 'user' ? colors.navy : '#f3f4f6', color: msg.role === 'user' ? 'white' : colors.navy, borderTopRightRadius: msg.role === 'user' ? '4px' : '16px', borderTopLeftRadius: msg.role === 'user' ? '16px' : '4px', boxShadow: msg.role === 'user' ? '0 2px 8px rgba(13,40,71,0.2)' : '0 1px 3px rgba(0,0,0,0.05)' }}>
                    {msg.text}
                  </div>
                  {msg.role === 'assistant' && msg.confidence && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '4px', paddingLeft: '4px' }}>
                      {Icons.activity('#9ca3af', 10)}
                      <span style={{ fontSize: '9px', color: '#9ca3af' }}>{msg.confidence}% confidence</span>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {aiTyping && (
              <div style={{ display: 'flex', gap: '8px' }}>
                <div style={{ width: '30px', height: '30px', borderRadius: '15px', background: 'linear-gradient(135deg, #4F46E5, #7C3AED)', display: 'flex', alignItems: 'center', justifyContent: 'center', animation: 'pulse 1.5s ease-in-out infinite' }}>
                  {Icons.robot('white', 14)}
                </div>
                <div style={{ backgroundColor: '#f3f4f6', borderRadius: '16px', borderTopLeftRadius: '4px', padding: '12px 16px', display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <div style={{ width: '8px', height: '8px', borderRadius: '4px', backgroundColor: '#4F46E5', animation: 'bounce 1.4s ease-in-out infinite' }} />
                  <div style={{ width: '8px', height: '8px', borderRadius: '4px', backgroundColor: '#7C3AED', animation: 'bounce 1.4s ease-in-out 0.15s infinite' }} />
                  <div style={{ width: '8px', height: '8px', borderRadius: '4px', backgroundColor: '#4F46E5', animation: 'bounce 1.4s ease-in-out 0.3s infinite' }} />
                </div>
              </div>
            )}
          </div>

          {/* Suggested Questions */}
          {aiMessages.length <= 2 && !aiTyping && (
            <div style={{ padding: '8px 12px', borderTop: '1px solid #eee', backgroundColor: '#f9fafb' }}>
              <p style={{ fontSize: '9px', fontWeight: '600', color: '#6b7280', marginBottom: '6px', textTransform: 'uppercase' }}>Try asking</p>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {suggestedQuestions.map((q, i) => (
                  <button key={i} onClick={() => { setAiInput(q.text); }} style={{ padding: '6px 10px', borderRadius: '16px', border: '1px solid rgba(13,40,71,0.15)', backgroundColor: 'white', cursor: 'pointer', fontSize: '11px', color: colors.navy, fontWeight: '500', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {q.icon(colors.navy, 12)}
                    {q.text}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Input */}
          <div style={{ padding: '10px 12px', borderTop: '1px solid #eee', backgroundColor: 'white' }}>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input key="ai-input" id="ai-input" type="text" value={aiInput} onChange={(e) => setAiInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendAiMessage()} placeholder="Ask me anything..." style={{ flex: 1, padding: '12px 16px', borderRadius: '24px', backgroundColor: '#f3f4f6', border: '1px solid rgba(0,0,0,0.05)', fontSize: '13px', outline: 'none', fontWeight: '500' }} autoComplete="off" />
              <button onClick={sendAiMessage} disabled={!aiInput.trim()} style={{ width: '42px', height: '42px', borderRadius: '21px', border: 'none', background: aiInput.trim() ? `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})` : '#e5e7eb', color: 'white', cursor: aiInput.trim() ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: aiInput.trim() ? '0 4px 12px rgba(13,40,71,0.3)' : 'none', transition: 'all 0.2s' }}>{Icons.send('white', 18)}</button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // HOME SCREEN
  const HomeScreen = () => (
    <div key="home-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.cream }}>
      {/* Header */}
      <div style={{ padding: '16px', paddingBottom: '20px', background: `linear-gradient(135deg, ${colors.navy} 0%, ${colors.navyLight} 50%, ${colors.navyMid} 100%)`, flexShrink: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <div>
            <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.6)', margin: 0, letterSpacing: '0.5px' }}>Good evening</p>
            <h1 style={{ fontSize: '20px', fontWeight: '900', color: 'white', margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>Hey, {profileName} {Icons.wave('white', 20)}</h1>
          </div>
          <button onClick={() => setCurrentTab('profile')} style={{ position: 'relative', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
            <div style={{ width: '40px', height: '40px', borderRadius: '20px', backgroundColor: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
              {profilePic ? <img src={profilePic} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : Icons.user('white', 22)}
            </div>
            <span style={{ position: 'absolute', bottom: '-2px', right: '-2px', padding: '2px 6px', borderRadius: '10px', fontSize: '9px', fontWeight: 'bold', color: 'white', backgroundColor: colors.amber }}>L{userLevel}</span>
          </button>
        </div>

        {/* Stats */}
        <div style={{ display: 'flex', gap: '8px' }}>
          <div style={{ flex: 1, borderRadius: '12px', padding: '10px', backgroundColor: 'rgba(255,255,255,0.1)' }}>
            <p style={{ fontSize: '9px', color: 'rgba(255,255,255,0.6)', margin: 0, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Active</p>
            <p style={{ fontSize: '18px', fontWeight: '900', color: 'white', margin: '2px 0 0' }}>{flocks.length} <span style={{ fontSize: '11px', fontWeight: '500' }}>Flocks</span></p>
          </div>
          <div style={{ flex: 1, borderRadius: '12px', padding: '10px', backgroundColor: 'rgba(255,255,255,0.1)' }}>
            <p style={{ fontSize: '9px', color: 'rgba(255,255,255,0.6)', margin: 0, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Streak</p>
            <p style={{ fontSize: '18px', fontWeight: '900', color: 'white', margin: '2px 0 0', display: 'flex', alignItems: 'center', gap: '4px' }}>{Icons.flame('#F59E0B', 18)} {streak}</p>
          </div>
          <div style={{ flex: 1, borderRadius: '12px', padding: '10px', backgroundColor: 'rgba(255,255,255,0.1)' }}>
            <p style={{ fontSize: '9px', color: 'rgba(255,255,255,0.6)', margin: 0, textTransform: 'uppercase', letterSpacing: '0.5px' }}>XP</p>
            <p style={{ fontSize: '18px', fontWeight: '900', color: 'white', margin: '2px 0 0' }}>{userXP}</p>
            <div style={{ width: '100%', height: '4px', backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: '2px', marginTop: '4px' }}>
              <div style={{ height: '100%', width: `${userXP % 100}%`, backgroundColor: colors.amber, borderRadius: '2px' }} />
            </div>
          </div>
        </div>
      </div>

      {/* Scrollable Content */}
      <div style={{ flex: 1, padding: '12px', overflowY: 'auto', marginTop: '-8px' }}>
        {/* Stories */}
        <div style={{ display: 'flex', gap: '12px', marginBottom: '12px', overflowX: 'auto', paddingBottom: '4px' }}>
          {stories.map(s => (
            <button key={s.id} onClick={() => showToast(`${s.name}'s story`)} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0 }}>
              <div style={{ width: '52px', height: '52px', borderRadius: '26px', padding: '2px', background: s.hasNew ? `linear-gradient(135deg, ${colors.navy}, ${colors.skyBlue})` : '#d1d5db' }}>
                <div style={{ width: '100%', height: '100%', borderRadius: '24px', backgroundColor: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '24px' }}>{s.avatar}</div>
              </div>
              <span style={{ fontSize: '11px', fontWeight: '600', color: colors.navy }}>{s.name}</span>
            </button>
          ))}
        </div>

        {/* Action Buttons */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
          <button onClick={() => setCurrentScreen('create')} style={{ flex: 1, padding: '12px', borderRadius: '12px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontWeight: 'bold', fontSize: '14px', cursor: 'pointer' }}>+ Start Flock</button>
          <button onClick={() => setCurrentScreen('join')} style={{ flex: 1, padding: '12px', borderRadius: '12px', border: `2px solid ${colors.navy}`, backgroundColor: 'white', color: colors.navy, fontWeight: 'bold', fontSize: '14px', cursor: 'pointer' }}>Join Flock</button>
        </div>

        {/* Activity */}
        <div style={styles.card}>
          <h3 style={{ fontSize: '12px', fontWeight: 'bold', color: colors.navy, margin: '0 0 8px' }}>🔔 Activity</h3>
          {activityFeed.map(a => (
            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', borderBottom: '1px solid #f3f4f6' }}>
              <span>{a.icon}</span>
              <p style={{ fontSize: '11px', flex: 1, margin: 0 }}><span style={{ fontWeight: 'bold' }}>{a.user}</span> {a.action} <span style={{ color: colors.navyMid }}>{a.target}</span></p>
              <span style={{ fontSize: '10px', color: '#9ca3af' }}>{a.time}</span>
            </div>
          ))}
        </div>

        {/* Flocks */}
        <h2 style={{ fontSize: '12px', fontWeight: 'bold', color: colors.navy, margin: '0 0 8px' }}>Your Flocks</h2>
        {flocks.map(f => (
          <button key={f.id} onClick={() => { setSelectedFlockId(f.id); setCurrentScreen('detail'); }} style={{ width: '100%', textAlign: 'left', ...styles.card, border: 'none', cursor: 'pointer' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
              <div>
                <h3 style={{ fontSize: '14px', fontWeight: 'bold', color: colors.navy, margin: 0 }}>{f.name}</h3>
                <p style={{ fontSize: '10px', color: '#6b7280', margin: '2px 0 0', display: 'flex', alignItems: 'center', gap: '3px' }}>{Icons.mapPin('#6b7280', 10)} {f.venue}</p>
              </div>
              <span style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '10px', fontWeight: '600', backgroundColor: f.status === 'voting' ? '#fef3c7' : '#d1fae5', color: f.status === 'voting' ? '#b45309' : '#047857' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>{f.status === 'voting' ? Icons.vote('#b45309', 10) : Icons.check('#047857', 10)} {f.status === 'voting' ? 'Voting' : 'Set'}</span>
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex' }}>
                {f.members.slice(0, 4).map((m, j) => (
                  <div key={j} style={{ width: '24px', height: '24px', borderRadius: '12px', border: '2px solid white', backgroundColor: colors.navyMid, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '9px', fontWeight: 'bold', color: 'white', marginLeft: j > 0 ? '-6px' : 0 }}>{m[0]}</div>
                ))}
              </div>
              <span style={{ fontSize: '10px', fontWeight: '600', padding: '2px 8px', borderRadius: '10px', backgroundColor: colors.cream, color: colors.navy }}>{f.time}</span>
            </div>
          </button>
        ))}

        {/* Safety Check-in */}
        <button onClick={() => setShowCheckin(true)} style={{ width: '100%', marginTop: '8px', padding: '12px', borderRadius: '12px', border: `2px dashed ${colors.teal}`, backgroundColor: 'transparent', color: colors.teal, fontWeight: 'bold', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
          {Icons.shield(colors.teal, 14)} Safety Check-in
        </button>
      </div>

      <AIButton />
      <SafetyButton />
      <BottomNav />
    </div>
  );

  // CREATE SCREEN
  const CreateScreen = () => {
    const handleCreate = () => {
      if (!flockName.trim()) { showToast('Enter a plan name', 'error'); return; }
      setIsLoading(true);
      setTimeout(() => {
        const venueName = selectedVenueForCreate?.name || 'TBD';
        const newFlock = { id: Date.now(), name: flockName, host: 'You', members: ['You', ...flockFriends], time: `${flockDate} ${flockTime}`, status: 'voting', venue: venueName, cashPool: flockCashPool ? { target: flockAmount * (flockFriends.length + 1), collected: flockAmount, perPerson: flockAmount, paid: ['You'] } : null, votes: [], messages: [{ id: 1, sender: 'You', time: 'Now', text: `Let's go! 🎉`, reactions: [] }] };
        setFlocks(prev => [...prev, newFlock]);
        addEventToCalendar(flockName, venueName, new Date(), flockTime, colors.navy);
        setFlockName(''); setFlockFriends([]); setFlockCashPool(false); setSelectedVenueForCreate(null);
        setIsLoading(false); setCurrentScreen('main');
        addXP(50); showToast(`"${newFlock.name}" created!`);
      }, 800);
    };

    return (
      <div key="create-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'white' }}>
        <div style={{ padding: '12px', display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid #eee', backgroundColor: colors.cream, flexShrink: 0 }}>
          <button onClick={() => { setCurrentScreen('main'); setFlockName(''); setFlockFriends([]); setSelectedVenueForCreate(null); }} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'transparent', color: colors.navy, fontSize: '18px', cursor: 'pointer' }}>←</button>
          <h1 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: 0 }}>Start a Flock</h1>
        </div>

        <div style={{ flex: 1, padding: '16px', overflowY: 'auto', backgroundColor: colors.cream }}>
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '6px' }}>What's the plan?</label>
            <input key="flock-name-input" id="flock-name-input" type="text" value={flockName} onChange={(e) => setFlockName(e.target.value)} placeholder="Movie night, dinner, party..." style={styles.input} autoComplete="off" />
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '6px' }}>{Icons.mapPin(colors.navy, 12)} Venue</label>
            {selectedVenueForCreate ? (
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', border: `2px solid ${colors.navy}`, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{ width: '40px', height: '40px', borderRadius: '8px', backgroundColor: colors.cream, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{selectedVenueForCreate.category === 'Food' ? Icons.pizza(colors.food, 20) : Icons.cocktail(colors.nightlife, 20)}</div>
                <div style={{ flex: 1 }}>
                  <p style={{ fontWeight: 'bold', fontSize: '14px', color: colors.navy, margin: 0 }}>{selectedVenueForCreate.name}</p>
                  <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>{selectedVenueForCreate.type}</p>
                </div>
                <button onClick={() => setSelectedVenueForCreate(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x(colors.red, 16)}</button>
              </div>
            ) : (
              <button onClick={() => { setPickingVenueForCreate(true); setCurrentTab('explore'); setCurrentScreen('main'); }} style={{ width: '100%', padding: '12px', borderRadius: '12px', border: `2px dashed ${colors.navyMid}`, backgroundColor: 'transparent', color: colors.navy, fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                {Icons.compass(colors.navy, 16)} Pick Venue
              </button>
            )}
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '6px' }}>When</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
              {['Tonight', 'Tomorrow', 'This Weekend', 'Next Week'].map(d => (
                <button key={d} onClick={() => setFlockDate(d)} style={{ padding: '10px', borderRadius: '8px', border: `2px solid ${flockDate === d ? colors.navy : colors.creamDark}`, backgroundColor: flockDate === d ? colors.navy : 'white', color: flockDate === d ? colors.cream : colors.navy, fontWeight: '600', fontSize: '12px', cursor: 'pointer' }}>{d}</button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '6px' }}>Time</label>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {['7 PM', '8 PM', '9 PM', '10 PM', '11 PM'].map(t => (
                <button key={t} onClick={() => setFlockTime(t)} style={{ padding: '6px 12px', borderRadius: '20px', border: `2px solid ${colors.navy}`, backgroundColor: flockTime === t ? colors.navy : 'white', color: flockTime === t ? colors.cream : colors.navy, fontWeight: '600', fontSize: '12px', cursor: 'pointer' }}>{t}</button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '6px' }}>Invite ({flockFriends.length})</label>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {allFriends.map(f => (
                <button key={f} onClick={() => setFlockFriends(prev => prev.includes(f) ? prev.filter(x => x !== f) : [...prev, f])} style={{ padding: '6px 10px', borderRadius: '20px', border: `2px solid ${colors.navy}`, backgroundColor: flockFriends.includes(f) ? colors.navy : 'white', color: flockFriends.includes(f) ? colors.cream : colors.navy, fontWeight: '600', fontSize: '12px', cursor: 'pointer' }}>
                  {flockFriends.includes(f) ? '✓ ' : ''}{f}
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <label style={{ fontSize: '12px', fontWeight: 'bold', color: colors.navy, display: 'flex', alignItems: 'center', gap: '4px' }}>{Icons.dollar(colors.navy, 14)} Cash Pool</label>
              <Toggle on={flockCashPool} onChange={() => setFlockCashPool(!flockCashPool)} />
            </div>
            {flockCashPool && (
              <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', border: `1px solid ${colors.creamDark}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <span style={{ fontSize: '12px', fontWeight: '500' }}>Per person</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <button onClick={() => setFlockAmount(prev => Math.max(5, prev - 5))} style={{ width: '32px', height: '32px', borderRadius: '16px', border: `2px solid ${colors.navy}`, backgroundColor: 'white', color: colors.navy, fontWeight: 'bold', cursor: 'pointer' }}>−</button>
                    <span style={{ fontSize: '20px', fontWeight: '900', width: '56px', textAlign: 'center', color: colors.navy }}>${flockAmount}</span>
                    <button onClick={() => setFlockAmount(prev => prev + 5)} style={{ width: '32px', height: '32px', borderRadius: '16px', border: `2px solid ${colors.navy}`, backgroundColor: 'white', color: colors.navy, fontWeight: 'bold', cursor: 'pointer' }}>+</button>
                  </div>
                </div>
                <p style={{ fontSize: '10px', color: '#6b7280', textAlign: 'center', margin: 0 }}>Total: ${flockAmount * (flockFriends.length + 1)}</p>
              </div>
            )}
          </div>
        </div>

        <div style={{ padding: '12px', backgroundColor: 'white', borderTop: '1px solid #eee', flexShrink: 0 }}>
          <button onClick={handleCreate} disabled={isLoading} style={{ ...styles.gradientButton, opacity: isLoading ? 0.5 : 1 }}>
            {isLoading ? <><span style={{ display: 'inline-flex', animation: 'spin 1s linear infinite' }}>{Icons.activity('white', 16)}</span> Creating...</> : <>{Icons.users('white', 16)} Create Flock</>}
          </button>
        </div>
      </div>
    );
  };

  // JOIN SCREEN
  const JoinScreen = () => (
    <div key="join-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'white' }}>
      <div style={{ padding: '12px', display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid #eee', backgroundColor: colors.cream, flexShrink: 0 }}>
        <button onClick={() => { setCurrentScreen('main'); setJoinCode(''); }} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'transparent', color: colors.navy, fontSize: '18px', cursor: 'pointer' }}>←</button>
        <h1 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: 0 }}>Join a Flock</h1>
      </div>
      <div style={{ flex: 1, padding: '16px', backgroundColor: colors.cream }}>
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '6px' }}>Enter Code</label>
          <input key="join-code-input" id="join-code-input" type="text" value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))} placeholder="ABC123" maxLength={6} style={{ ...styles.input, fontSize: '20px', textAlign: 'center', letterSpacing: '8px', textTransform: 'uppercase' }} autoComplete="off" />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', margin: '24px 0' }}>
          <div style={{ flex: 1, height: '1px', backgroundColor: '#d1d5db' }} />
          <span style={{ color: '#9ca3af', fontSize: '12px' }}>or</span>
          <div style={{ flex: 1, height: '1px', backgroundColor: '#d1d5db' }} />
        </div>
        <button onClick={() => showToast('Camera opening...')} style={{ width: '100%', padding: '12px', borderRadius: '12px', border: `2px solid ${colors.creamDark}`, backgroundColor: 'white', color: colors.navy, fontWeight: '500', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>{Icons.camera(colors.navy, 16)} Scan QR</button>
      </div>
      <div style={{ padding: '12px', backgroundColor: 'white', borderTop: '1px solid #eee', flexShrink: 0 }}>
        <button onClick={() => { if (joinCode.length === 6) { showToast('✅ Joined!'); addXP(20); setJoinCode(''); setCurrentScreen('main'); } else { showToast('Enter valid code', 'error'); }}} style={styles.gradientButton}>Join Flock</button>
      </div>
    </div>
  );

  // EXPLORE SCREEN
  const ExploreScreen = () => (
    <div key="explore-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: '#e5e7eb' }}>
      {pickingVenueForCreate && (
        <div style={{ padding: '8px 12px', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <span style={{ color: 'white', fontSize: '12px', fontWeight: '500', display: 'flex', alignItems: 'center', gap: '4px' }}>{Icons.mapPin('white', 12)} Tap venue to select</span>
          <button onClick={() => { setPickingVenueForCreate(false); setCurrentScreen('create'); }} style={{ backgroundColor: 'rgba(255,255,255,0.2)', border: 'none', borderRadius: '10px', padding: '2px 8px', color: 'white', fontSize: '10px', cursor: 'pointer' }}>Cancel</button>
        </div>
      )}

      <div style={{ padding: '8px', display: 'flex', alignItems: 'center', gap: '8px', backgroundColor: 'white', boxShadow: '0 2px 4px rgba(0,0,0,0.1)', zIndex: 20, flexShrink: 0 }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <input key="search-input" id="search-input" type="text" value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Search venues..." style={{ width: '100%', padding: '10px 10px 10px 32px', borderRadius: '20px', backgroundColor: '#f3f4f6', border: 'none', fontSize: '12px', outline: 'none', boxSizing: 'border-box' }} autoComplete="off" />
          <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }}>{Icons.search('#9ca3af', 14)}</span>
        </div>
        <button onClick={() => setShowConnectPanel(true)} style={{ width: '36px', height: '36px', borderRadius: '18px', border: 'none', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.users('white', 18)}</button>
      </div>

      {/* Map */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0, background: '#e8ebe4' }}>
          {/* Grid */}
          <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
            <defs>
              <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#d0d0d0" strokeWidth="0.5"/>
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#grid)" />
            <rect x="0" y="30%" width="100%" height="16" fill="#a0a0a0"/>
            <rect x="0" y="60%" width="100%" height="20" fill="#909090"/>
            <rect x="25%" y="0" width="14" height="100%" fill="#a0a0a0"/>
            <rect x="65%" y="0" width="18" height="100%" fill="#909090"/>
          </svg>

          {/* Enhanced Heatmap with multi-layer pulsing gradients */}
          {getFilteredVenues().map(v => {
            const intensity = v.crowd / 100;
            const baseColor = v.crowd > 70 ? '#EF4444' : v.crowd > 50 ? '#F59E0B' : v.crowd > 30 ? '#FBBF24' : '#10B981';
            const innerSize = 40 + (intensity * 60);
            const outerSize = 80 + (intensity * 100);
            const pulseDelay = (v.id * 0.3) % 2;
            return (
              <div key={`heat-${v.id}`} style={{ position: 'absolute', left: `${v.x}%`, top: `${v.y}%`, transform: 'translate(-50%, -50%)', pointerEvents: 'none' }}>
                {/* Outer glow layer */}
                <div style={{ position: 'absolute', left: '50%', top: '50%', width: `${outerSize}px`, height: `${outerSize}px`, transform: 'translate(-50%, -50%)', borderRadius: '50%', background: `radial-gradient(circle, ${baseColor}20 0%, ${baseColor}08 50%, transparent 70%)`, animation: `pulse 3s ease-in-out infinite ${pulseDelay}s` }} />
                {/* Middle pulsing layer */}
                <div style={{ position: 'absolute', left: '50%', top: '50%', width: `${innerSize * 1.5}px`, height: `${innerSize * 1.5}px`, transform: 'translate(-50%, -50%)', borderRadius: '50%', background: `radial-gradient(circle, ${baseColor}35 0%, ${baseColor}15 40%, transparent 70%)`, animation: `pulse 2s ease-in-out infinite ${pulseDelay + 0.5}s` }} />
                {/* Inner bright core */}
                <div style={{ position: 'absolute', left: '50%', top: '50%', width: `${innerSize}px`, height: `${innerSize}px`, transform: 'translate(-50%, -50%)', borderRadius: '50%', background: `radial-gradient(circle, ${baseColor}50 0%, ${baseColor}25 50%, transparent 80%)`, animation: `pulse 1.5s ease-in-out infinite ${pulseDelay + 0.2}s` }} />
              </div>
            );
          })}

          {/* Venue pins */}
          {getFilteredVenues().map(v => (
            <button key={v.id} onClick={() => setActiveVenue(v)} style={{ position: 'absolute', left: `${v.x}%`, top: `${v.y}%`, transform: 'translate(-50%, -100%)', background: 'none', border: 'none', cursor: 'pointer', zIndex: activeVenue?.id === v.id ? 30 : 10, transition: 'transform 0.2s' }}>
              <div style={{ position: 'relative' }}>
                <svg width="28" height="36" viewBox="0 0 24 32">
                  <path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20c0-6.6-5.4-12-12-12z" fill={getCategoryColor(v.category)}/>
                  <circle cx="12" cy="11" r="6" fill="white"/>
                </svg>
                <span style={{ position: 'absolute', top: '6px', left: '50%', transform: 'translateX(-50%)' }}>{v.category === 'Food' ? Icons.pizza(colors.food, 14) : v.category === 'Nightlife' ? Icons.cocktail(colors.nightlife, 14) : v.category === 'Live Music' ? Icons.music(colors.music, 14) : Icons.sports(colors.sports, 14)}</span>
                {v.trending && <span style={{ position: 'absolute', top: '-4px', right: '-8px' }}>{Icons.flame('#F59E0B', 12)}</span>}
              </div>
            </button>
          ))}

          {/* User location */}
          <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', zIndex: 20 }}>
            <div style={{ width: '16px', height: '16px', borderRadius: '8px', backgroundColor: '#3b82f6', border: '3px solid white', boxShadow: '0 2px 4px rgba(0,0,0,0.3)' }} />
          </div>
        </div>

        {/* Connect Panel */}
        {showConnectPanel && (
          <div style={{ position: 'absolute', left: '8px', right: '8px', top: '8px', backgroundColor: 'white', borderRadius: '12px', boxShadow: '0 4px 20px rgba(0,0,0,0.2)', zIndex: 40, maxHeight: '65%', overflow: 'auto' }}>
            <div style={{ padding: '12px', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'sticky', top: 0, backgroundColor: 'white', borderRadius: '12px 12px 0 0' }}>
              <h2 style={{ fontSize: '14px', fontWeight: '900', color: colors.navy, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.users(colors.navy, 16)} Find Your Flock</h2>
              <button onClick={() => setShowConnectPanel(false)} style={{ width: '24px', height: '24px', borderRadius: '12px', backgroundColor: '#f3f4f6', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x('#6b7280', 14)}</button>
            </div>
            <div style={{ padding: '12px' }}>
              {connections.map(c => (
                <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', borderRadius: '8px', backgroundColor: colors.cream, marginBottom: '8px' }}>
                  <div style={{ width: '40px', height: '40px', borderRadius: '20px', backgroundColor: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>{c.interests[0] === 'Live Music' ? Icons.music(colors.music, 20) : Icons.sports(colors.sports, 20)}</div>
                  <div style={{ flex: 1 }}>
                    <p style={{ fontWeight: 'bold', fontSize: '12px', color: colors.navy, margin: 0 }}>{c.name}</p>
                    <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>{c.loc} • {c.distance}</p>
                  </div>
                  <button onClick={() => { setConnections(prev => prev.map(conn => conn.id === c.id ? { ...conn, status: 'pending' } : conn)); showToast('Request sent!'); }} disabled={c.status === 'pending'} style={{ padding: '6px 12px', borderRadius: '20px', border: 'none', fontSize: '10px', fontWeight: 'bold', cursor: 'pointer', backgroundColor: c.status === 'pending' ? '#e5e7eb' : colors.navy, color: c.status === 'pending' ? '#6b7280' : 'white' }}>
                    {c.status === 'pending' ? 'Pending' : 'Connect'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Venue Popup with AI Crowd Forecast */}
        {activeVenue && !showConnectPanel && (
          <div style={{ position: 'absolute', bottom: '12px', left: '8px', right: '8px', backgroundColor: 'white', borderRadius: '16px', boxShadow: '0 4px 20px rgba(0,0,0,0.2)', zIndex: 30, overflow: 'hidden', maxHeight: '70%', overflowY: 'auto' }}>
            <div style={{ height: '56px', background: `linear-gradient(135deg, ${getCategoryColor(activeVenue.category)}, ${activeVenue.crowd > 70 ? colors.red : colors.navy})`, position: 'relative', padding: '8px 12px', display: 'flex', alignItems: 'flex-end' }}>
              <button onClick={() => setActiveVenue(null)} style={{ position: 'absolute', top: '8px', right: '8px', width: '24px', height: '24px', borderRadius: '12px', backgroundColor: 'rgba(255,255,255,0.2)', border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x('white', 14)}</button>
              <div style={{ color: 'white' }}>
                <h3 style={{ fontSize: '14px', fontWeight: '900', margin: 0 }}>{activeVenue.name}</h3>
                <p style={{ fontSize: '10px', opacity: 0.8, margin: 0 }}>{activeVenue.type} • {activeVenue.price}</p>
              </div>
              <div style={{ position: 'absolute', bottom: '8px', right: '40px', display: 'flex', alignItems: 'center', gap: '2px', backgroundColor: 'rgba(255,255,255,0.2)', padding: '2px 6px', borderRadius: '10px' }}>
                {Icons.party('#fbbf24', 10)}
                <span style={{ color: 'white', fontSize: '10px', fontWeight: 'bold', marginLeft: '2px' }}>{activeVenue.stars}</span>
              </div>
            </div>
            <div style={{ padding: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '10px', color: '#6b7280', marginBottom: '8px' }}>
                {Icons.mapPin('#6b7280', 12)}
                <span>{activeVenue.addr}</span>
              </div>

              {/* AI Crowd Forecast Widget */}
              <div style={{ backgroundColor: '#f9fafb', borderRadius: '12px', padding: '10px', marginBottom: '10px', border: '1px solid rgba(13,40,71,0.08)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {Icons.robot(colors.navy, 14)}
                    <span style={{ fontSize: '11px', fontWeight: 'bold', color: colors.navy }}>AI Crowd Forecast</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <div style={{ width: '6px', height: '6px', borderRadius: '3px', backgroundColor: '#22C55E', animation: 'pulse 2s ease-in-out infinite' }} />
                    <span style={{ fontSize: '9px', color: '#22C55E', fontWeight: '500' }}>LIVE</span>
                    <span style={{ fontSize: '9px', padding: '2px 6px', borderRadius: '10px', backgroundColor: '#dbeafe', color: '#1d4ed8', fontWeight: '600' }}>87% accuracy</span>
                  </div>
                </div>

                {/* Crowd Meter */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                  <div style={{ width: '50px', height: '50px', borderRadius: '25px', background: `conic-gradient(${activeVenue.crowd > 70 ? colors.red : activeVenue.crowd > 40 ? colors.amber : colors.teal} ${activeVenue.crowd * 3.6}deg, #e5e7eb 0deg)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ width: '40px', height: '40px', borderRadius: '20px', backgroundColor: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
                      <span style={{ fontSize: '14px', fontWeight: '900', color: activeVenue.crowd > 70 ? colors.red : activeVenue.crowd > 40 ? colors.amber : colors.teal }}>{activeVenue.crowd}%</span>
                    </div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <p style={{ fontSize: '11px', fontWeight: '600', color: colors.navy, margin: 0 }}>{activeVenue.crowd > 70 ? 'Very Busy' : activeVenue.crowd > 40 ? 'Moderate' : 'Not Busy'}</p>
                    <p style={{ fontSize: '10px', color: '#6b7280', margin: '2px 0' }}>Capacity: ~{Math.round(activeVenue.crowd * 1.5)} / 150 people</p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      {Icons.clock(colors.teal, 10)}
                      <span style={{ fontSize: '10px', fontWeight: 'bold', color: colors.teal }}>Best time: {activeVenue.best}</span>
                    </div>
                  </div>
                </div>

                {/* Hourly Forecast Graph */}
                <div style={{ marginBottom: '10px' }}>
                  <p style={{ fontSize: '9px', fontWeight: '600', color: '#6b7280', marginBottom: '6px', textTransform: 'uppercase' }}>Hourly Forecast</p>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: '3px', height: '40px' }}>
                    {[30, 35, 45, 55, 70, 85, 90, 80, 65, 50, 35, 25].map((h, i) => (
                      <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
                        <div style={{ width: '100%', height: `${h * 0.4}px`, borderRadius: '2px', backgroundColor: h > 70 ? colors.red : h > 40 ? colors.amber : colors.teal, opacity: i === 5 ? 1 : 0.6 }} />
                        <span style={{ fontSize: '7px', color: '#9ca3af' }}>{6 + i}p</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Peak Time Prediction */}
                <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                  <div style={{ flex: 1, backgroundColor: 'white', borderRadius: '8px', padding: '6px 8px', border: '1px solid rgba(0,0,0,0.05)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '2px' }}>
                      {Icons.trendingUp(colors.red, 10)}
                      <span style={{ fontSize: '8px', color: '#6b7280', textTransform: 'uppercase' }}>Peak</span>
                    </div>
                    <span style={{ fontSize: '11px', fontWeight: '700', color: colors.navy }}>10-11 PM</span>
                  </div>
                  <div style={{ flex: 1, backgroundColor: 'white', borderRadius: '8px', padding: '6px 8px', border: '1px solid rgba(0,0,0,0.05)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '2px' }}>
                      {Icons.zap(colors.amber, 10)}
                      <span style={{ fontSize: '8px', color: '#6b7280', textTransform: 'uppercase' }}>Wait</span>
                    </div>
                    <span style={{ fontSize: '11px', fontWeight: '700', color: colors.navy }}>{activeVenue.crowd > 70 ? '15-20 min' : activeVenue.crowd > 40 ? '5-10 min' : 'No wait'}</span>
                  </div>
                </div>

                {/* Similar Venues */}
                <div>
                  <p style={{ fontSize: '9px', fontWeight: '600', color: '#6b7280', marginBottom: '6px', textTransform: 'uppercase' }}>Less Crowded Nearby</p>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {allVenues.filter(v => v.id !== activeVenue.id && v.category === activeVenue.category).slice(0, 2).map(v => (
                      <button key={v.id} onClick={() => setActiveVenue(v)} style={{ flex: 1, padding: '6px', backgroundColor: 'white', border: '1px solid rgba(0,0,0,0.08)', borderRadius: '8px', cursor: 'pointer', textAlign: 'left' }}>
                        <p style={{ fontSize: '10px', fontWeight: '600', color: colors.navy, margin: 0 }}>{v.name}</p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '2px' }}>
                          <div style={{ width: '6px', height: '6px', borderRadius: '3px', backgroundColor: v.crowd > 70 ? colors.red : v.crowd > 40 ? colors.amber : colors.teal }} />
                          <span style={{ fontSize: '9px', color: '#6b7280' }}>{v.crowd}% full</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '6px' }}>
                {pickingVenueForCreate ? (
                  <button onClick={() => { setSelectedVenueForCreate(activeVenue); setActiveVenue(null); setPickingVenueForCreate(false); setCurrentScreen('create'); showToast('Selected!'); }} style={{ flex: 1, padding: '10px', borderRadius: '8px', border: 'none', backgroundColor: colors.teal, color: 'white', fontWeight: 'bold', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>{Icons.check('white', 14)} Select</button>
                ) : (
                  <button onClick={() => { setSelectedVenueForCreate(activeVenue); setActiveVenue(null); setCurrentScreen('create'); }} style={{ flex: 1, padding: '10px', borderRadius: '8px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontWeight: 'bold', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>{Icons.users('white', 14)} Flock Here</button>
                )}
                <button onClick={() => addEventToCalendar(`Visit ${activeVenue.name}`, activeVenue.name, new Date(), '8 PM', getCategoryColor(activeVenue.category))} style={{ width: '40px', height: '40px', borderRadius: '8px', border: `2px solid ${colors.creamDark}`, backgroundColor: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.calendar(colors.navy, 18)}</button>
                <button onClick={() => showToast('Calling venue...')} style={{ width: '40px', height: '40px', borderRadius: '8px', border: `2px solid ${colors.creamDark}`, backgroundColor: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.wave(colors.navy, 18)}</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Categories */}
      <div style={{ padding: '8px', backgroundColor: 'white', boxShadow: '0 -2px 4px rgba(0,0,0,0.1)', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: '6px', overflowX: 'auto' }}>
          {[
              { id: 'All', icon: () => Icons.sparkles(category === 'All' ? colors.cream : colors.navy, 14) },
              { id: 'Food', icon: () => Icons.pizza(category === 'Food' ? colors.cream : colors.food, 14) },
              { id: 'Nightlife', icon: () => Icons.cocktail(category === 'Nightlife' ? colors.cream : colors.nightlife, 14) },
              { id: 'Live Music', icon: () => Icons.music(category === 'Live Music' ? colors.cream : colors.music, 14) },
              { id: 'Sports', icon: () => Icons.sports(category === 'Sports' ? colors.cream : colors.sports, 14) }
            ].map(c => (
            <button key={c.id} onClick={() => { setCategory(c.id); setActiveVenue(null); }} style={{ padding: '8px 12px', borderRadius: '20px', border: `2px solid ${colors.navy}`, backgroundColor: category === c.id ? colors.navy : 'white', color: category === c.id ? colors.cream : colors.navy, fontWeight: 'bold', fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
              {c.icon()} {c.id}
            </button>
          ))}
        </div>
      </div>

      <SafetyButton />
      <BottomNav />
    </div>
  );

  // CALENDAR SCREEN (simplified)
  const CalendarScreen = () => {
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const dayNames = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const daysInMonth = getDaysInMonth(calendarMonth);
    const firstDay = getFirstDayOfMonth(calendarMonth);
    const selectedDateStr = formatDateStr(selectedDate);
    const eventsOnSelected = getEventsForDate(selectedDateStr);
    const today = new Date();
    const todayStr = formatDateStr(today);
    const isToday = (dateStr) => dateStr === todayStr;

    // Event categories
    const eventCategories = [
      { id: 'social', label: 'Social', color: colors.navy, icon: Icons.users },
      { id: 'dining', label: 'Dining', color: colors.food, icon: Icons.pizza },
      { id: 'nightlife', label: 'Nightlife', color: colors.nightlife, icon: Icons.cocktail },
      { id: 'music', label: 'Music', color: colors.music, icon: Icons.music },
    ];

    // Upcoming events (next 7 days)
    const getUpcomingEvents = () => {
      const upcoming = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() + i);
        const events = getEventsForDate(formatDateStr(d));
        events.forEach(e => upcoming.push({ ...e, dayLabel: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString('en-US', { weekday: 'short' }) }));
      }
      return upcoming.slice(0, 4);
    };

    // Weather data (mock)
    const getWeatherForDate = (dateStr) => {
      const weathers = [
        { icon: Icons.sun, temp: '72°', condition: 'Sunny' },
        { icon: Icons.cloud, temp: '65°', condition: 'Cloudy' },
        { icon: Icons.sun, temp: '78°', condition: 'Clear' },
      ];
      return weathers[Math.abs(dateStr.split('-')[2]) % 3];
    };

    const weather = getWeatherForDate(selectedDateStr);

    return (
      <div key="calendar-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.cream }}>
        {/* Header */}
        <div style={{ padding: '12px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
            <button onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.arrowLeft('white', 16)}</button>
            <div style={{ textAlign: 'center' }}>
              <h1 style={{ fontSize: '18px', fontWeight: '900', color: 'white', margin: 0 }}>{monthNames[calendarMonth.getMonth()]}</h1>
              <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.6)', margin: 0 }}>{calendarMonth.getFullYear()}</p>
            </div>
            <button onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.arrowRight('white', 16)}</button>
          </div>
          {/* Today Quick Jump */}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={() => { setCalendarMonth(today); setSelectedDate(today); }} style={{ flex: 1, padding: '8px', borderRadius: '10px', border: 'none', backgroundColor: 'rgba(255,255,255,0.15)', color: 'white', fontSize: '11px', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
              {Icons.zap('#F59E0B', 12)}
              Jump to Today
            </button>
          </div>
        </div>

        {/* Day names header */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px', padding: '8px', backgroundColor: 'white' }}>
          {dayNames.map((d, i) => <div key={i} style={{ textAlign: 'center', fontSize: '10px', fontWeight: 'bold', color: '#9ca3af' }}>{d}</div>)}
        </div>

        {/* Calendar grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px', padding: '0 8px 8px', backgroundColor: 'white', flexShrink: 0 }}>
          {[...Array(firstDay)].map((_, i) => <div key={`e-${i}`} style={{ height: '40px' }} />)}
          {[...Array(daysInMonth)].map((_, i) => {
            const day = i + 1;
            const dateStr = `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const events = getEventsForDate(dateStr);
            const isSelected = dateStr === selectedDateStr;
            const isTodayDate = isToday(dateStr);
            const isBusy = events.length >= 2;
            return (
              <button key={day} onClick={() => setSelectedDate(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), day))} style={{ height: '40px', borderRadius: '10px', border: isTodayDate && !isSelected ? `2px solid ${colors.teal}` : 'none', backgroundColor: isSelected ? colors.navy : isBusy ? 'rgba(13,40,71,0.05)' : 'transparent', color: isSelected ? 'white' : isTodayDate ? colors.teal : 'inherit', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
                <span style={{ fontSize: '12px', fontWeight: isTodayDate || isSelected ? '700' : '500' }}>{day}</span>
                {events.length > 0 && (
                  <div style={{ display: 'flex', gap: '2px', marginTop: '2px' }}>
                    {events.slice(0, 3).map((e, idx) => <div key={idx} style={{ width: '5px', height: '5px', borderRadius: '50%', backgroundColor: isSelected ? 'white' : e.color }} />)}
                  </div>
                )}
                {isBusy && !isSelected && <div style={{ position: 'absolute', top: '2px', right: '4px', width: '6px', height: '6px', borderRadius: '3px', backgroundColor: colors.amber }} />}
              </button>
            );
          })}
        </div>

        {/* Events section */}
        <div style={{ flex: 1, padding: '12px', overflowY: 'auto' }}>
          {/* Weather widget for selected date */}
          <div style={{ ...styles.card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', background: 'linear-gradient(135deg, #dbeafe, #e0f2fe)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              {weather.icon('#F59E0B', 28)}
              <div>
                <p style={{ fontSize: '16px', fontWeight: '700', color: colors.navy, margin: 0 }}>{weather.temp}</p>
                <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>{weather.condition}</p>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <p style={{ fontSize: '12px', fontWeight: '600', color: colors.navy, margin: 0 }}>{selectedDate.toLocaleDateString('en-US', { weekday: 'long' })}</p>
              <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>{selectedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</p>
            </div>
          </div>

          {/* Selected date events header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <h3 style={{ fontSize: '14px', fontWeight: '900', color: colors.navy, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
              {Icons.calendar(colors.navy, 14)}
              {isToday(selectedDateStr) ? 'Today' : selectedDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
            </h3>
            <button onClick={() => setShowAddEvent(true)} style={{ padding: '6px 12px', borderRadius: '20px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontSize: '10px', fontWeight: 'bold', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
              {Icons.plus('white', 12)} Add
            </button>
          </div>

          {/* Events list */}
          {eventsOnSelected.length > 0 ? eventsOnSelected.map(event => (
            <div key={event.id} style={{ ...styles.card, display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ width: '44px', height: '44px', borderRadius: '10px', background: `linear-gradient(135deg, ${event.color}, ${event.color}cc)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {Icons.party('white', 20)}
              </div>
              <div style={{ flex: 1 }}>
                <p style={{ fontWeight: 'bold', fontSize: '14px', color: colors.navy, margin: 0 }}>{event.title}</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
                  <span style={{ fontSize: '10px', color: '#6b7280', display: 'flex', alignItems: 'center', gap: '3px' }}>{Icons.clock('#6b7280', 10)} {event.time}</span>
                  <span style={{ fontSize: '10px', color: '#6b7280', display: 'flex', alignItems: 'center', gap: '3px' }}>{Icons.mapPin('#6b7280', 10)} {event.venue}</span>
                </div>
                {event.members > 1 && <div style={{ display: 'flex', alignItems: 'center', gap: '3px', marginTop: '4px' }}>{Icons.users('#6b7280', 10)}<span style={{ fontSize: '9px', color: '#6b7280' }}>{event.members} going</span></div>}
              </div>
              <button onClick={() => setCalendarEvents(calendarEvents.filter(e => e.id !== event.id))} style={{ width: '28px', height: '28px', borderRadius: '14px', backgroundColor: '#fee2e2', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x(colors.red, 14)}</button>
            </div>
          )) : (
            <div style={{ textAlign: 'center', padding: '24px' }}>
              {Icons.calendar('#9ca3af', 40)}
              <p style={{ color: '#9ca3af', fontSize: '14px', margin: '8px 0 0' }}>No events scheduled</p>
            </div>
          )}

          {/* Add event form */}
          {showAddEvent && (
            <div style={{ ...styles.card, marginTop: '12px', border: `2px solid ${colors.navy}` }}>
              <h4 style={{ fontSize: '13px', fontWeight: 'bold', color: colors.navy, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.plus(colors.navy, 14)} New Event</h4>
              <input key="event-title" id="event-title" type="text" value={newEventTitle} onChange={(e) => setNewEventTitle(e.target.value)} placeholder="Event title" style={{ ...styles.input, marginBottom: '8px' }} autoComplete="off" />
              <input key="event-venue" id="event-venue" type="text" value={newEventVenue} onChange={(e) => setNewEventVenue(e.target.value)} placeholder="Venue (optional)" style={{ ...styles.input, marginBottom: '10px' }} autoComplete="off" />
              {/* Event categories */}
              <p style={{ fontSize: '10px', fontWeight: '600', color: '#6b7280', marginBottom: '6px' }}>Category</p>
              <div style={{ display: 'flex', gap: '6px', marginBottom: '10px', flexWrap: 'wrap' }}>
                {eventCategories.map(cat => (
                  <button key={cat.id} style={{ padding: '6px 10px', borderRadius: '16px', border: `1px solid ${cat.color}`, backgroundColor: 'white', cursor: 'pointer', fontSize: '10px', color: cat.color, fontWeight: '500', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {cat.icon(cat.color, 12)} {cat.label}
                  </button>
                ))}
              </div>
              {/* Repeat toggle */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid #eee', marginBottom: '10px' }}>
                <span style={{ fontSize: '11px', fontWeight: '500', color: colors.navy, display: 'flex', alignItems: 'center', gap: '4px' }}>{Icons.repeat(colors.navy, 12)} Repeat weekly</span>
                <Toggle on={false} onChange={() => showToast('Repeat enabled')} />
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={() => { setShowAddEvent(false); setNewEventTitle(''); setNewEventVenue(''); }} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: '1px solid #d1d5db', backgroundColor: 'white', fontWeight: '600', fontSize: '13px', cursor: 'pointer' }}>Cancel</button>
                <button onClick={() => { if (newEventTitle.trim()) { addEventToCalendar(newEventTitle, newEventVenue || 'TBD', selectedDate, '7:00 PM', colors.navy); setNewEventTitle(''); setNewEventVenue(''); setShowAddEvent(false); }}} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontWeight: 'bold', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>{Icons.check('white', 14)} Add</button>
              </div>
            </div>
          )}

          {/* Upcoming events preview */}
          {!showAddEvent && getUpcomingEvents().length > 0 && (
            <div style={{ marginTop: '16px' }}>
              <h4 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: '4px' }}>{Icons.trendingUp(colors.navy, 12)} Coming Up</h4>
              {getUpcomingEvents().map((event, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', borderRadius: '10px', backgroundColor: 'white', marginBottom: '6px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
                  <div style={{ width: '4px', height: '32px', borderRadius: '2px', backgroundColor: event.color }} />
                  <div style={{ flex: 1 }}>
                    <p style={{ fontSize: '12px', fontWeight: '600', color: colors.navy, margin: 0 }}>{event.title}</p>
                    <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>{event.dayLabel} at {event.time}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <SafetyButton />
        <BottomNav />
      </div>
    );
  };

  // CHAT LIST SCREEN
  const ChatListScreen = () => (
    <div key="chat-list-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.cream }}>
      <div style={{ padding: '16px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, flexShrink: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1 style={{ fontSize: '20px', fontWeight: '900', color: 'white', margin: 0 }}>Messages</h1>
            <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.6)', margin: 0 }}>{flocks.length} conversations</p>
          </div>
          <button onClick={() => setShowChatSearch(!showChatSearch)} style={{ width: '36px', height: '36px', borderRadius: '18px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {Icons.search('white', 18)}
          </button>
        </div>
        {showChatSearch && (
          <div style={{ marginTop: '12px' }}>
            <input key="chat-search" id="chat-search" type="text" value={chatSearch} onChange={(e) => setChatSearch(e.target.value)} placeholder="Search conversations..." style={{ width: '100%', padding: '10px 14px', borderRadius: '20px', border: 'none', fontSize: '13px', outline: 'none', backgroundColor: 'rgba(255,255,255,0.95)' }} autoComplete="off" />
          </div>
        )}
      </div>
      <div style={{ flex: 1, padding: '12px', overflowY: 'auto' }}>
        {flocks.filter(f => !chatSearch || f.name.toLowerCase().includes(chatSearch.toLowerCase())).map((f, idx) => {
          const unreadCount = idx === 0 ? 3 : idx === 1 ? 1 : 0;
          const isOnline = idx < 2;
          const lastMsg = f.messages[f.messages.length - 1];
          return (
            <button key={f.id} onClick={() => { setSelectedFlockId(f.id); setCurrentScreen('chatDetail'); simulateTyping(); }} style={{ width: '100%', textAlign: 'left', ...styles.card, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '12px', position: 'relative' }}>
              <div style={{ position: 'relative' }}>
                <div style={{ width: '48px', height: '48px', borderRadius: '14px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 8px rgba(13,40,71,0.2)' }}>
                  {Icons.users('white', 22)}
                </div>
                {isOnline && <div style={{ position: 'absolute', bottom: '-2px', right: '-2px', width: '14px', height: '14px', borderRadius: '7px', backgroundColor: '#22C55E', border: '2px solid white' }} />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 style={{ fontSize: '14px', fontWeight: unreadCount ? '800' : '600', color: colors.navy, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</h3>
                  <span style={{ fontSize: '10px', color: unreadCount ? colors.navy : '#9ca3af', fontWeight: unreadCount ? '600' : '400' }}>{getRelativeTime(lastMsg?.time)}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  {lastMsg?.sender === 'You' && <span style={{ flexShrink: 0 }}>{Icons.checkDouble('#22C55E', 12)}</span>}
                  <p style={{ fontSize: '12px', color: unreadCount ? colors.navy : '#6b7280', fontWeight: unreadCount ? '500' : '400', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lastMsg?.sender === 'You' ? '' : `${lastMsg?.sender}: `}{lastMsg?.text}</p>
                </div>
              </div>
              {unreadCount > 0 && (
                <div style={{ width: '22px', height: '22px', borderRadius: '11px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontSize: '11px', fontWeight: '700', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {unreadCount}
                </div>
              )}
            </button>
          );
        })}
      </div>
      <SafetyButton />
      <BottomNav />
    </div>
  );

  // CHAT DETAIL SCREEN - No hooks inside, uses parent's ref and callback
  const ChatDetailScreen = () => {
    const flock = getSelectedFlock();
    const reactions = ['❤️', '👍', '😂', '🔥'];

    return (
      <div key="chat-detail-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'white' }}>
        <div style={{ padding: '12px', display: 'flex', alignItems: 'center', gap: '8px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, flexShrink: 0 }}>
          <button onClick={() => { setCurrentScreen('main'); setChatInput(''); setReplyingTo(null); }} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.arrowLeft('white', 20)}</button>
          <div style={{ flex: 1 }}>
            <h2 style={{ fontWeight: 'bold', color: 'white', fontSize: '14px', margin: 0 }}>{flock.name}</h2>
            <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.6)', margin: 0 }}>{flock.members.length} members • {isTyping ? <span style={{ color: '#22C55E' }}>typing...</span> : 'online'}</p>
          </div>
          <button onClick={() => setShowChatSearch(!showChatSearch)} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.search('white', 16)}</button>
          <button onClick={() => setShowChatPool(true)} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: colors.cream, color: colors.navy, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.dollar(colors.navy, 16)}</button>
        </div>

        <div style={{ flex: 1, padding: '16px', overflowY: 'auto', background: `linear-gradient(180deg, ${colors.cream} 0%, rgba(245,240,230,0.8) 100%)` }}>
          {flock.messages.map((m, idx) => (
            <div key={m.id} style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexDirection: m.sender === 'You' ? 'row-reverse' : 'row', position: 'relative' }}>
              <div style={{ position: 'relative', flexShrink: 0 }}>
                <div style={{ width: '34px', height: '34px', borderRadius: '17px', background: m.sender === 'You' ? `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})` : 'white', border: m.sender === 'You' ? 'none' : '2px solid rgba(13,40,71,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: '700', color: m.sender === 'You' ? 'white' : colors.navy, boxShadow: m.sender === 'You' ? '0 3px 10px rgba(13,40,71,0.25)' : '0 2px 6px rgba(0,0,0,0.06)' }}>
                  {m.sender[0]}
                </div>
                {m.sender !== 'You' && idx === 0 && <div style={{ position: 'absolute', bottom: '-1px', right: '-1px', width: '10px', height: '10px', borderRadius: '5px', backgroundColor: '#22C55E', border: '2px solid white' }} />}
              </div>
              <div style={{ maxWidth: '72%', display: 'flex', flexDirection: 'column', alignItems: m.sender === 'You' ? 'flex-end' : 'flex-start' }}>
                <p style={{ fontSize: '10px', color: '#9ca3af', marginBottom: '4px', padding: '0 4px', fontWeight: '500' }}>{m.sender} • {getRelativeTime(m.time)}</p>
                <div
                  onClick={() => setShowReactionPicker(showReactionPicker === m.id ? null : m.id)}
                  style={{ borderRadius: '18px', padding: '10px 14px', background: m.sender === 'You' ? `linear-gradient(135deg, ${colors.navy} 0%, ${colors.navyMid} 100%)` : 'rgba(255,255,255,0.95)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', color: m.sender === 'You' ? 'white' : colors.navy, borderBottomRightRadius: m.sender === 'You' ? '4px' : '18px', borderBottomLeftRadius: m.sender === 'You' ? '18px' : '4px', boxShadow: m.sender === 'You' ? '0 3px 12px rgba(13,40,71,0.2)' : '0 2px 10px rgba(0,0,0,0.05)', border: m.sender === 'You' ? 'none' : '1px solid rgba(255,255,255,0.8)', cursor: 'pointer', position: 'relative' }}>
                  <p style={{ fontSize: '14px', lineHeight: '1.45', margin: 0, fontWeight: '500' }}>{m.text}</p>
                  {m.sender === 'You' && (
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '4px', gap: '2px' }}>
                      {Icons.checkDouble('#22C55E', 12)}
                    </div>
                  )}
                </div>
                {showReactionPicker === m.id && (
                  <div style={{ display: 'flex', gap: '6px', marginTop: '6px', padding: '6px 10px', backgroundColor: 'white', borderRadius: '20px', boxShadow: '0 4px 15px rgba(0,0,0,0.15)' }}>
                    {reactions.map(r => (
                      <button key={r} onClick={(e) => { e.stopPropagation(); addReactionToMessage(flock.id, m.id, r); }} style={{ background: 'none', border: 'none', fontSize: '18px', cursor: 'pointer', padding: '4px', borderRadius: '8px', transition: 'transform 0.1s' }}>{r}</button>
                    ))}
                    <button onClick={(e) => { e.stopPropagation(); setReplyingTo(m); setShowReactionPicker(null); }} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', display: 'flex', alignItems: 'center' }}>{Icons.reply('#6b7280', 16)}</button>
                  </div>
                )}
                {m.reactions.length > 0 && (
                  <div style={{ display: 'flex', gap: '4px', marginTop: '6px' }}>
                    {m.reactions.map((r, i) => <span key={i} style={{ fontSize: '14px', backgroundColor: 'white', borderRadius: '12px', padding: '3px 7px', boxShadow: '0 2px 6px rgba(0,0,0,0.08)', border: '1px solid rgba(0,0,0,0.05)' }}>{r}</span>)}
                  </div>
                )}
              </div>
            </div>
          ))}
          {isTyping && (
            <div style={{ display: 'flex', gap: '10px', marginBottom: '16px' }}>
              <div style={{ width: '34px', height: '34px', borderRadius: '17px', backgroundColor: 'white', border: '2px solid rgba(13,40,71,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: '700', color: colors.navy }}>A</div>
              <div style={{ padding: '12px 16px', backgroundColor: 'white', borderRadius: '18px', borderBottomLeftRadius: '4px', boxShadow: '0 2px 10px rgba(0,0,0,0.05)' }}>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <div style={{ width: '8px', height: '8px', borderRadius: '4px', backgroundColor: '#9ca3af', animation: 'bounce 1.4s ease-in-out infinite' }} />
                  <div style={{ width: '8px', height: '8px', borderRadius: '4px', backgroundColor: '#9ca3af', animation: 'bounce 1.4s ease-in-out 0.2s infinite' }} />
                  <div style={{ width: '8px', height: '8px', borderRadius: '4px', backgroundColor: '#9ca3af', animation: 'bounce 1.4s ease-in-out 0.4s infinite' }} />
                </div>
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        {replyingTo && (
          <div style={{ padding: '8px 16px', backgroundColor: 'rgba(13,40,71,0.05)', borderTop: '1px solid rgba(0,0,0,0.05)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: '3px', height: '32px', backgroundColor: colors.navy, borderRadius: '2px' }} />
            <div style={{ flex: 1 }}>
              <p style={{ fontSize: '11px', fontWeight: '600', color: colors.navy, margin: 0 }}>Replying to {replyingTo.sender}</p>
              <p style={{ fontSize: '11px', color: '#6b7280', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{replyingTo.text}</p>
            </div>
            <button onClick={() => setReplyingTo(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>{Icons.x('#6b7280', 16)}</button>
          </div>
        )}

        <div style={{ padding: '10px 12px', backgroundColor: 'rgba(255,255,255,0.98)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', borderTop: '1px solid rgba(0,0,0,0.05)', display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0, boxShadow: '0 -4px 20px rgba(0,0,0,0.03)' }}>
          <button onClick={() => showToast('Opening camera...')} style={{ width: '36px', height: '36px', borderRadius: '18px', border: 'none', backgroundColor: 'rgba(13,40,71,0.08)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.image('#6b7280', 18)}</button>
          <input key="chat-input" id="chat-input" type="text" value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendChatMessage()} placeholder={replyingTo ? 'Reply...' : 'Type a message...'} style={{ flex: 1, padding: '11px 16px', borderRadius: '22px', backgroundColor: 'rgba(243,244,246,0.9)', border: '1px solid rgba(0,0,0,0.05)', fontSize: '14px', outline: 'none', fontWeight: '500' }} autoComplete="off" />
          {chatInput ? (
            <button onClick={sendChatMessage} style={{ width: '40px', height: '40px', borderRadius: '20px', border: 'none', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 3px 10px rgba(13,40,71,0.25)' }}>{Icons.send('white', 17)}</button>
          ) : (
            <button onClick={() => showToast('Recording voice...')} style={{ width: '40px', height: '40px', borderRadius: '20px', border: 'none', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 3px 10px rgba(13,40,71,0.25)' }}>{Icons.mic('white', 18)}</button>
          )}
        </div>

        {showChatPool && (
          <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
            <div style={{ backgroundColor: 'white', borderRadius: '16px 16px 0 0', padding: '16px', width: '100%' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <h2 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: 0 }}>💰 Cash Pool</h2>
                <button onClick={() => setShowChatPool(false)} style={{ width: '32px', height: '32px', borderRadius: '16px', backgroundColor: '#f3f4f6', border: 'none', cursor: 'pointer' }}>✕</button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', marginBottom: '12px' }}>
                <button onClick={() => setChatPoolAmount(prev => Math.max(5, prev - 5))} style={{ width: '40px', height: '40px', borderRadius: '20px', border: `2px solid ${colors.navy}`, backgroundColor: 'white', color: colors.navy, fontWeight: 'bold', cursor: 'pointer' }}>−</button>
                <span style={{ fontSize: '32px', fontWeight: '900', width: '80px', textAlign: 'center', color: colors.navy }}>${chatPoolAmount}</span>
                <button onClick={() => setChatPoolAmount(prev => prev + 5)} style={{ width: '40px', height: '40px', borderRadius: '20px', border: `2px solid ${colors.navy}`, backgroundColor: 'white', color: colors.navy, fontWeight: 'bold', cursor: 'pointer' }}>+</button>
              </div>
              <p style={{ fontSize: '12px', color: '#6b7280', textAlign: 'center', marginBottom: '16px' }}>Per person • Total: ${chatPoolAmount * flock.members.length}</p>
              <button onClick={() => { addMessageToFlock(selectedFlockId, { id: Date.now(), sender: 'You', time: 'Now', text: `💰 Pool: $${chatPoolAmount}/person`, reactions: [] }); setShowChatPool(false); showToast('💰 Pool created!'); }} style={styles.gradientButton}>Create Pool</button>
            </div>
          </div>
        )}
      </div>
    );
  };

  // FLOCK DETAIL SCREEN
  const FlockDetailScreen = () => {
    const flock = getSelectedFlock();
    const myVote = flock.votes.find(v => v.voters.includes('You'))?.venue || null;

    const handleVote = (venueName) => {
      const newVotes = flock.votes.map(v => ({ ...v, voters: v.venue === venueName ? (v.voters.includes('You') ? v.voters : [...v.voters, 'You']) : v.voters.filter(x => x !== 'You') }));
      updateFlockVotes(selectedFlockId, newVotes);
      addXP(10);
      showToast(`Voted for ${venueName}!`);
    };

    return (
      <div key="flock-detail-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.cream }}>
        <div style={{ padding: '12px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <button onClick={() => setCurrentScreen('main')} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer' }}>←</button>
            <div style={{ flex: 1 }}>
              <h1 style={{ fontWeight: '900', color: 'white', fontSize: '14px', margin: 0 }}>{flock.name}</h1>
              <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.6)', margin: 0 }}>{flock.host} • {flock.time}</p>
            </div>
            <button onClick={() => addEventToCalendar(flock.name, flock.venue, new Date(), '9 PM')} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer', fontSize: '14px' }}>📅</button>
          </div>
          <div style={{ display: 'flex' }}>
            {flock.members.slice(0, 5).map((m, i) => (
              <div key={i} style={{ width: '24px', height: '24px', borderRadius: '12px', backgroundColor: 'rgba(255,255,255,0.3)', border: '2px solid white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '9px', fontWeight: 'bold', color: 'white', marginLeft: i > 0 ? '-6px' : 0 }}>{m[0]}</div>
            ))}
            <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.6)', marginLeft: '8px', alignSelf: 'center' }}>{flock.members.length} going</span>
          </div>
        </div>

        <div style={{ flex: 1, padding: '12px', overflowY: 'auto' }}>
          {flock.cashPool && (
            <div style={styles.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <h3 style={{ fontSize: '12px', fontWeight: 'bold', color: colors.navy, margin: 0 }}>💰 Cash Pool</h3>
                <span style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '10px', fontWeight: '500', backgroundColor: flock.cashPool.collected >= flock.cashPool.target ? '#d1fae5' : '#fef3c7', color: flock.cashPool.collected >= flock.cashPool.target ? '#047857' : '#b45309' }}>
                  ${flock.cashPool.collected}/${flock.cashPool.target}
                </span>
              </div>
              <div style={{ width: '100%', height: '8px', backgroundColor: '#e5e7eb', borderRadius: '4px', marginBottom: '8px', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${(flock.cashPool.collected / flock.cashPool.target) * 100}%`, background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, borderRadius: '4px' }} />
              </div>
              {!flock.cashPool.paid.includes('You') ? (
                <button onClick={() => makePoolPayment(selectedFlockId)} style={{ ...styles.gradientButton, padding: '8px' }}>Pay ${flock.cashPool.perPerson}</button>
              ) : (
                <div style={{ textAlign: 'center', padding: '4px', color: colors.teal, fontWeight: '600', fontSize: '12px' }}>✓ Paid!</div>
              )}
            </div>
          )}

          <h2 style={{ fontSize: '12px', fontWeight: 'bold', color: colors.navy, margin: '0 0 8px' }}>🗳 Vote</h2>
          {flock.votes.map(v => (
            <button key={v.venue} onClick={() => handleVote(v.venue)} style={{ width: '100%', textAlign: 'left', ...styles.card, border: 'none', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ fontSize: '14px', fontWeight: 'bold', color: colors.navy, margin: 0 }}>{v.venue}</h3>
                <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>{v.type}</p>
                <p style={{ fontSize: '9px', color: colors.navyMid, margin: '2px 0 0' }}>{v.voters.join(', ')}</p>
              </div>
              <span style={{ padding: '6px 16px', borderRadius: '20px', fontSize: '12px', fontWeight: 'bold', backgroundColor: myVote === v.venue ? colors.navy : colors.cream, color: myVote === v.venue ? 'white' : colors.navy }}>
                {myVote === v.venue ? '✓ ' : ''}{v.voters.length}
              </span>
            </button>
          ))}

          <button onClick={() => setCurrentScreen('chatDetail')} style={{ width: '100%', textAlign: 'left', ...styles.card, border: 'none', cursor: 'pointer', marginTop: '12px' }}>
            <h2 style={{ fontSize: '12px', fontWeight: 'bold', color: colors.navy, margin: '0 0 4px' }}>💬 Chat</h2>
            <p style={{ fontSize: '11px', color: '#6b7280', margin: 0 }}>{flock.messages[flock.messages.length - 1]?.sender}: {flock.messages[flock.messages.length - 1]?.text}</p>
          </button>
        </div>

        <div style={{ padding: '12px', backgroundColor: 'white', borderTop: '1px solid #eee', flexShrink: 0 }}>
          <button onClick={() => showToast('📍 Location shared!')} style={styles.gradientButton}>Share Location 📍</button>
        </div>
      </div>
    );
  };

  // PROFILE SCREEN (simplified)
  const ProfileScreen = () => {
    if (profileScreen !== 'main') {
      return (
        <div key={`profile-${profileScreen}-container`} style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.cream }}>
          <div style={{ padding: '12px', display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid #eee', backgroundColor: 'white', flexShrink: 0 }}>
            <button onClick={() => setProfileScreen('main')} style={{ background: 'none', border: 'none', color: colors.navy, fontSize: '18px', cursor: 'pointer' }}>←</button>
            <h1 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: 0 }}>{profileScreen === 'edit' ? 'Edit Profile' : profileScreen === 'safety' ? 'Safety' : profileScreen === 'interests' ? 'Interests' : 'Payment'}</h1>
          </div>
          <div style={{ flex: 1, padding: '16px', overflowY: 'auto' }}>
            {profileScreen === 'edit' && (
              <div>
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                  <button onClick={() => setShowPicModal(true)} style={{ width: '80px', height: '80px', borderRadius: '40px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                    {profilePic ? <img src={profilePic} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ fontSize: '32px' }}>👤</span>}
                  </button>
                </div>
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '4px' }}>Name</label>
                  <input key="profile-name" id="profile-name" type="text" value={profileName} onChange={(e) => setProfileName(e.target.value)} style={styles.input} autoComplete="off" />
                </div>
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '4px' }}>Username</label>
                  <input key="profile-handle" id="profile-handle" type="text" value={profileHandle} onChange={(e) => setProfileHandle(e.target.value)} style={styles.input} autoComplete="off" />
                </div>
                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: colors.navy, marginBottom: '4px' }}>Bio</label>
                  <textarea key="profile-bio" id="profile-bio" value={profileBio} onChange={(e) => setProfileBio(e.target.value)} rows={2} style={{ ...styles.input, resize: 'none' }} />
                </div>
              </div>
            )}
            {profileScreen === 'safety' && (
              <div>
                <div style={styles.card}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <p style={{ fontWeight: 'bold', fontSize: '14px', color: colors.navy, margin: 0 }}>Safety Features</p>
                      <p style={{ fontSize: '10px', color: '#6b7280', margin: 0 }}>Quick exit & check-ins</p>
                    </div>
                    <Toggle on={safetyOn} onChange={() => setSafetyOn(!safetyOn)} />
                  </div>
                </div>
                <div style={styles.card}>
                  <h3 style={{ fontWeight: 'bold', fontSize: '14px', color: colors.navy, margin: '0 0 8px' }}>Trusted Contacts</h3>
                  {trustedContacts.map(c => (
                    <div key={c} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
                      <span style={{ fontWeight: '500', fontSize: '14px', color: colors.navy }}>{c}</span>
                      <button onClick={() => { setTrustedContacts(trustedContacts.filter(x => x !== c)); showToast('Removed'); }} style={{ background: 'none', border: 'none', color: colors.red, fontSize: '12px', fontWeight: '500', cursor: 'pointer' }}>Remove</button>
                    </div>
                  ))}
                  <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                    <input key="new-contact" id="new-contact" type="text" value={newContactName} onChange={(e) => setNewContactName(e.target.value)} placeholder="Add contact..." style={{ ...styles.input, flex: 1 }} autoComplete="off" />
                    <button onClick={() => { if (newContactName.trim()) { setTrustedContacts([...trustedContacts, newContactName.trim()]); showToast('✅ Added!'); setNewContactName(''); }}} style={{ padding: '0 16px', borderRadius: '8px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontWeight: 'bold', fontSize: '14px', cursor: 'pointer' }}>Add</button>
                  </div>
                </div>
              </div>
            )}
          </div>
          <div style={{ padding: '12px', backgroundColor: 'white', borderTop: '1px solid #eee', flexShrink: 0 }}>
            <button onClick={() => { showToast('✅ Saved!'); setProfileScreen('main'); }} style={styles.gradientButton}>Save</button>
          </div>
        </div>
      );
    }

    return (
      <div key="profile-main-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.cream }}>
        <div style={{ padding: '20px', textAlign: 'center', background: `linear-gradient(135deg, ${colors.navy} 0%, ${colors.navyLight} 50%, ${colors.navyMid} 100%)`, flexShrink: 0 }}>
          <button onClick={() => setShowPicModal(true)} style={{ width: '80px', height: '80px', borderRadius: '40px', margin: '0 auto 8px', backgroundColor: 'rgba(255,255,255,0.2)', border: '4px solid rgba(255,255,255,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', cursor: 'pointer' }}>
            {profilePic ? <img src={profilePic} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ fontSize: '32px' }}>👤</span>}
          </button>
          <h1 style={{ fontSize: '20px', fontWeight: '900', color: 'white', margin: 0 }}>{profileName}</h1>
          <p style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', margin: 0 }}>@{profileHandle}</p>
          <div style={{ marginTop: '12px', backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: '12px', padding: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
              <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: '10px' }}>Level {userLevel}</span>
              <span style={{ color: 'white', fontWeight: 'bold', fontSize: '12px' }}>{userXP} XP</span>
            </div>
            <div style={{ width: '100%', height: '6px', backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: '3px' }}>
              <div style={{ height: '100%', width: `${userXP % 100}%`, backgroundColor: colors.amber, borderRadius: '3px' }} />
            </div>
          </div>
        </div>

        <div style={{ flex: 1, padding: '12px', overflowY: 'auto', marginTop: '-8px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px', marginBottom: '12px' }}>
            {[{ l: 'Flocks', v: flocks.length }, { l: 'Friends', v: 48 }, { l: 'Streak', v: `${streak}🔥` }, { l: 'Events', v: calendarEvents.length }].map(s => (
              <div key={s.l} style={{ backgroundColor: 'white', borderRadius: '12px', padding: '8px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
                <p style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: 0 }}>{s.v}</p>
                <p style={{ fontSize: '9px', color: '#6b7280', margin: 0 }}>{s.l}</p>
              </div>
            ))}
          </div>

          <div style={{ backgroundColor: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden' }}>
            {[
              { l: 'Edit Profile', s: 'edit', i: '👤' },
              { l: 'Interests', s: 'interests', i: '🎯' },
              { l: 'Safety', s: 'safety', i: '🛡️' },
              { l: 'Payment', s: 'payment', i: '💳' },
            ].map(m => (
              <button key={m.s} onClick={() => setProfileScreen(m.s)} style={{ width: '100%', padding: '12px', textAlign: 'left', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: '12px', backgroundColor: 'white', border: 'none', cursor: 'pointer' }}>
                <span style={{ fontSize: '18px' }}>{m.i}</span>
                <span style={{ flex: 1, fontWeight: '600', fontSize: '14px', color: colors.navy }}>{m.l}</span>
                <span style={{ color: '#9ca3af' }}>→</span>
              </button>
            ))}
            <button onClick={() => showToast('Logged out!')} style={{ width: '100%', padding: '12px', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '12px', backgroundColor: 'white', border: 'none', cursor: 'pointer', color: colors.red }}>
              {Icons.logout(colors.red, 18)}
              <span style={{ fontWeight: '600', fontSize: '14px' }}>Log Out</span>
            </button>
          </div>

          {/* Admin Access Button - Small and subtle at bottom */}
          <button
            onClick={() => setShowAdminPrompt(true)}
            style={{
              marginTop: '16px',
              padding: '8px 12px',
              borderRadius: '8px',
              border: `1px dashed ${colors.creamDark}`,
              backgroundColor: 'transparent',
              color: '#9ca3af',
              fontSize: '10px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              justifyContent: 'center'
            }}
          >
            {Icons.settings('#9ca3af', 12)} Admin
          </button>

          {/* Venue Owner Access Button */}
          <button
            onClick={() => setCurrentScreen('venueDashboard')}
            style={{
              marginTop: '8px',
              padding: '8px 12px',
              borderRadius: '8px',
              border: `1px dashed ${colors.creamDark}`,
              backgroundColor: 'transparent',
              color: '#9ca3af',
              fontSize: '10px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              justifyContent: 'center'
            }}
          >
            {Icons.home('#9ca3af', 12)} Venue Dashboard
          </button>
        </div>

        <SafetyButton />
        <BottomNav />
      </div>
    );
  };

  // VENUE DASHBOARD SCREEN (For Venue Owners)
  const VenueDashboard = () => {
    const [dealDescription, setDealDescription] = useState('');
    const [dealTimeSlot, setDealTimeSlot] = useState('Happy Hour');
    const [showUpgradeModal, setShowUpgradeModal] = useState(false);

    // Mock venue data
    const venueData = {
      name: "The Blue Heron Bar",
      logo: null,
      tier: venueTier,
      todayCheckins: 47,
      weekTraffic: 312,
      crowdForecast: 78,
      peakHours: [
        { hour: '6pm', value: 30 },
        { hour: '7pm', value: 45 },
        { hour: '8pm', value: 65 },
        { hour: '9pm', value: 85 },
        { hour: '10pm', value: 95 },
        { hour: '11pm', value: 80 },
        { hour: '12am', value: 55 },
      ],
      topInterests: ['Live Music', 'Cocktails', 'Sports'],
      repeatRate: 34,
      demographics: { '21-25': 35, '26-30': 40, '31-35': 15, '36+': 10 },
    };

    const tierBadge = {
      free: { label: 'Free', color: '#6b7280', bg: '#f3f4f6' },
      premium: { label: 'Premium', color: '#b45309', bg: '#fef3c7' },
      pro: { label: 'Pro', color: '#7c3aed', bg: '#ede9fe' },
    };

    const features = {
      free: ['Basic listing', 'Venue info', 'User reviews'],
      premium: ['Enhanced visibility', 'Post deals', 'Event promotion', 'Basic analytics'],
      pro: ['Everything in Premium', 'Detailed insights', 'Push notifications', 'AI recommendations'],
    };

    const isFeatureLocked = (feature) => {
      if (venueTier === 'pro') return false;
      if (venueTier === 'premium' && ['Post deals', 'Event promotion', 'Basic analytics', 'Enhanced visibility'].includes(feature)) return false;
      if (['Basic listing', 'Venue info', 'User reviews'].includes(feature)) return false;
      return true;
    };

    return (
      <div key="venue-dashboard-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.cream }}>
        {/* Header */}
        <div style={{ padding: '16px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <button onClick={() => setCurrentScreen('main')} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {Icons.arrowLeft('white', 16)}
            </button>
            <span style={{ ...tierBadge[venueData.tier], padding: '4px 10px', borderRadius: '12px', fontSize: '10px', fontWeight: '700', backgroundColor: tierBadge[venueData.tier].bg, color: tierBadge[venueData.tier].color }}>
              {tierBadge[venueData.tier].label}
            </span>
          </div>
          <div style={{ marginTop: '12px', display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ width: '48px', height: '48px', borderRadius: '12px', backgroundColor: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {Icons.home('white', 24)}
            </div>
            <div>
              <h1 style={{ fontSize: '18px', fontWeight: '900', color: 'white', margin: 0 }}>Welcome, {venueData.name}</h1>
              <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.7)', margin: 0 }}>Venue Dashboard</p>
            </div>
          </div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
          {/* Key Metrics */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px', marginBottom: '12px' }}>
            <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
              <p style={{ fontSize: '9px', color: '#6b7280', margin: 0, textTransform: 'uppercase' }}>Today's Check-ins</p>
              <p style={{ fontSize: '24px', fontWeight: '900', color: colors.navy, margin: '4px 0 0' }}>{venueData.todayCheckins}</p>
            </div>
            <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
              <p style={{ fontSize: '9px', color: '#6b7280', margin: 0, textTransform: 'uppercase' }}>This Week</p>
              <p style={{ fontSize: '24px', fontWeight: '900', color: colors.navy, margin: '4px 0 0' }}>{venueData.weekTraffic}</p>
            </div>
            <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
              <p style={{ fontSize: '9px', color: '#6b7280', margin: 0, textTransform: 'uppercase' }}>Crowd Forecast</p>
              <p style={{ fontSize: '24px', fontWeight: '900', color: venueData.crowdForecast > 70 ? colors.red : colors.teal, margin: '4px 0 0' }}>{venueData.crowdForecast}%</p>
            </div>
            <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', position: 'relative' }}>
              <p style={{ fontSize: '9px', color: '#6b7280', margin: 0, textTransform: 'uppercase' }}>Repeat Rate</p>
              <p style={{ fontSize: '24px', fontWeight: '900', color: colors.navy, margin: '4px 0 0' }}>{venueData.repeatRate}%</p>
              {isFeatureLocked('Detailed insights') && <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(255,255,255,0.8)', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.shield('#9ca3af', 20)}</div>}
            </div>
          </div>

          {/* Demographics */}
          <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', marginBottom: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', position: 'relative' }}>
            <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Customer Demographics</h3>
            <div style={{ display: 'flex', gap: '4px', alignItems: 'flex-end', height: '60px' }}>
              {Object.entries(venueData.demographics).map(([age, pct]) => (
                <div key={age} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <div style={{ width: '100%', height: `${pct * 0.6}px`, backgroundColor: colors.navy, borderRadius: '4px 4px 0 0' }} />
                  <span style={{ fontSize: '8px', color: '#6b7280', marginTop: '4px' }}>{age}</span>
                  <span style={{ fontSize: '9px', fontWeight: '600', color: colors.navy }}>{pct}%</span>
                </div>
              ))}
            </div>
            {isFeatureLocked('Detailed insights') && <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: '12px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>{Icons.shield('#9ca3af', 24)}<span style={{ fontSize: '10px', color: '#6b7280', marginTop: '4px' }}>Pro Feature</span></div>}
          </div>

          {/* Post a Deal */}
          <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', marginBottom: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', position: 'relative' }}>
            <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.zap(colors.amber, 14)} Post a Deal</h3>
            <input
              type="text"
              value={dealDescription}
              onChange={(e) => setDealDescription(e.target.value)}
              placeholder="e.g., 2-for-1 drinks until 8pm"
              style={{ width: '100%', padding: '10px', borderRadius: '8px', border: `1px solid ${colors.creamDark}`, fontSize: '12px', marginBottom: '8px', boxSizing: 'border-box' }}
              disabled={isFeatureLocked('Post deals')}
            />
            <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
              {['Happy Hour', 'Late Night', 'Weekend', 'All Day'].map(slot => (
                <button key={slot} onClick={() => setDealTimeSlot(slot)} style={{ padding: '6px 10px', borderRadius: '16px', border: `1px solid ${dealTimeSlot === slot ? colors.navy : colors.creamDark}`, backgroundColor: dealTimeSlot === slot ? colors.navy : 'white', color: dealTimeSlot === slot ? 'white' : colors.navy, fontSize: '10px', fontWeight: '500', cursor: 'pointer' }} disabled={isFeatureLocked('Post deals')}>
                  {slot}
                </button>
              ))}
            </div>
            <button onClick={() => { showToast('Deal posted!'); setDealDescription(''); }} style={{ width: '100%', padding: '10px', borderRadius: '8px', border: 'none', background: `linear-gradient(90deg, ${colors.navy}, ${colors.navyMid})`, color: 'white', fontWeight: '600', fontSize: '12px', cursor: 'pointer' }} disabled={isFeatureLocked('Post deals') || !dealDescription.trim()}>
              Post Deal
            </button>
            {isFeatureLocked('Post deals') && <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: '12px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>{Icons.shield('#9ca3af', 24)}<span style={{ fontSize: '10px', color: '#6b7280', marginTop: '4px' }}>Premium Feature</span></div>}
          </div>

          {/* Peak Hours */}
          <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', marginBottom: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', position: 'relative' }}>
            <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Peak Hours (Tonight)</h3>
            <div style={{ display: 'flex', gap: '4px', alignItems: 'flex-end', height: '50px' }}>
              {venueData.peakHours.map((h, i) => (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <div style={{ width: '100%', height: `${h.value * 0.5}px`, backgroundColor: h.value > 80 ? colors.red : h.value > 50 ? colors.amber : colors.teal, borderRadius: '2px', transition: 'all 0.3s' }} />
                  <span style={{ fontSize: '8px', color: '#6b7280', marginTop: '4px' }}>{h.hour}</span>
                </div>
              ))}
            </div>
            {isFeatureLocked('Basic analytics') && <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(255,255,255,0.9)', borderRadius: '12px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>{Icons.shield('#9ca3af', 24)}<span style={{ fontSize: '10px', color: '#6b7280', marginTop: '4px' }}>Premium Feature</span></div>}
          </div>

          {/* Top Interests */}
          <div style={{ backgroundColor: 'white', borderRadius: '12px', padding: '12px', marginBottom: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
            <h3 style={{ fontSize: '12px', fontWeight: '700', color: colors.navy, margin: '0 0 10px' }}>Top Visitor Interests</h3>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {venueData.topInterests.map(interest => (
                <span key={interest} style={{ padding: '6px 12px', borderRadius: '16px', backgroundColor: colors.cream, fontSize: '11px', fontWeight: '500', color: colors.navy }}>
                  {interest}
                </span>
              ))}
            </div>
          </div>

          {/* Upgrade Button (if not Pro) */}
          {venueTier !== 'pro' && (
            <button onClick={() => setShowUpgradeModal(true)} style={{ width: '100%', padding: '14px', borderRadius: '12px', border: 'none', background: 'linear-gradient(135deg, #7c3aed, #a78bfa)', color: 'white', fontWeight: '700', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', boxShadow: '0 4px 12px rgba(124,58,237,0.3)' }}>
              {Icons.sparkles('white', 18)} Upgrade to {venueTier === 'free' ? 'Premium' : 'Pro'}
            </button>
          )}

          {/* Upgrade Modal */}
          {showUpgradeModal && (
            <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '16px' }}>
              <div style={{ backgroundColor: 'white', borderRadius: '24px', padding: '20px', width: '100%', maxWidth: '320px', maxHeight: '80%', overflowY: 'auto' }}>
                <h2 style={{ fontSize: '18px', fontWeight: '900', color: colors.navy, margin: '0 0 16px', textAlign: 'center' }}>Choose Your Plan</h2>

                {/* Free Tier */}
                <div style={{ border: `2px solid ${venueTier === 'free' ? colors.navy : colors.creamDark}`, borderRadius: '12px', padding: '12px', marginBottom: '10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontWeight: '700', color: colors.navy }}>Free</span>
                    <span style={{ fontWeight: '900', color: colors.navy }}>$0/mo</span>
                  </div>
                  <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '11px', color: '#6b7280' }}>
                    {features.free.map(f => <li key={f} style={{ marginBottom: '2px' }}>{f}</li>)}
                  </ul>
                  {venueTier === 'free' && <span style={{ display: 'block', textAlign: 'center', fontSize: '10px', color: colors.teal, fontWeight: '600', marginTop: '8px' }}>Current Plan</span>}
                </div>

                {/* Premium Tier */}
                <div style={{ border: `2px solid ${venueTier === 'premium' ? '#b45309' : colors.creamDark}`, borderRadius: '12px', padding: '12px', marginBottom: '10px', backgroundColor: venueTier === 'premium' ? '#fffbeb' : 'white' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontWeight: '700', color: '#b45309' }}>Premium</span>
                    <span style={{ fontWeight: '900', color: '#b45309' }}>$35/mo</span>
                  </div>
                  <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '11px', color: '#6b7280' }}>
                    {features.premium.map(f => <li key={f} style={{ marginBottom: '2px' }}>{f}</li>)}
                  </ul>
                  {venueTier === 'premium' ? <span style={{ display: 'block', textAlign: 'center', fontSize: '10px', color: '#b45309', fontWeight: '600', marginTop: '8px' }}>Current Plan</span> : venueTier === 'free' && <button onClick={() => { setVenueTier('premium'); setShowUpgradeModal(false); showToast('Upgraded to Premium!'); }} style={{ width: '100%', padding: '8px', borderRadius: '8px', border: 'none', backgroundColor: '#b45309', color: 'white', fontWeight: '600', fontSize: '12px', cursor: 'pointer', marginTop: '8px' }}>Upgrade</button>}
                </div>

                {/* Pro Tier */}
                <div style={{ border: '2px solid #7c3aed', borderRadius: '12px', padding: '12px', marginBottom: '16px', backgroundColor: '#faf5ff' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontWeight: '700', color: '#7c3aed' }}>Pro</span>
                    <span style={{ fontWeight: '900', color: '#7c3aed' }}>$75/mo</span>
                  </div>
                  <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '11px', color: '#6b7280' }}>
                    {features.pro.map(f => <li key={f} style={{ marginBottom: '2px' }}>{f}</li>)}
                  </ul>
                  <button onClick={() => { setVenueTier('pro'); setShowUpgradeModal(false); showToast('Upgraded to Pro!'); }} style={{ width: '100%', padding: '8px', borderRadius: '8px', border: 'none', background: 'linear-gradient(90deg, #7c3aed, #a78bfa)', color: 'white', fontWeight: '600', fontSize: '12px', cursor: 'pointer', marginTop: '8px' }}>Upgrade to Pro</button>
                </div>

                <button onClick={() => setShowUpgradeModal(false)} style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #d1d5db', backgroundColor: 'white', color: '#6b7280', fontWeight: '500', cursor: 'pointer' }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  // REVENUE SIMULATOR SCREEN
  const RevenueScreen = () => {
    // Revenue simulator state
    const [numVenues, setNumVenues] = useState(20);
    const [subscriptionPrice, setSubscriptionPrice] = useState(50);
    const [eventsPerVenue, setEventsPerVenue] = useState(12);
    const [avgSpend, setAvgSpend] = useState(120);
    const [takeRate, setTakeRate] = useState(2.5);
    const [operatingCosts, setOperatingCosts] = useState(2000);

    // Calculate all metrics
    const subscriptionRevenue = calculateSubscriptionRevenue(numVenues, subscriptionPrice);
    const transactionRevenue = calculateTransactionRevenue(numVenues, eventsPerVenue, avgSpend, takeRate);
    const totalMonthlyRevenue = calculateTotalMonthlyRevenue(subscriptionRevenue, transactionRevenue);
    const annualRevenue = calculateAnnualRevenue(totalMonthlyRevenue);
    const monthlyProfit = calculateMonthlyProfit(totalMonthlyRevenue, operatingCosts);
    const revenuePerVenue = calculateRevenuePerVenue(totalMonthlyRevenue, numVenues);
    const breakEvenVenues = calculateBreakEven(operatingCosts, subscriptionPrice, eventsPerVenue, avgSpend, takeRate);
    const profitMargin = calculateProfitMargin(monthlyProfit, totalMonthlyRevenue);
    const isProfitable = monthlyProfit >= 0;
    const isAboveBreakEven = numVenues >= breakEvenVenues;

    // Input field style
    const inputStyle = {
      width: '100%',
      padding: '10px 12px',
      borderRadius: '8px',
      border: `1px solid ${colors.creamDark}`,
      fontSize: '14px',
      fontWeight: '600',
      color: colors.navy,
      backgroundColor: 'white',
      outline: 'none',
      boxSizing: 'border-box',
    };

    const labelStyle = {
      fontSize: '11px',
      fontWeight: '700',
      color: colors.navy,
      marginBottom: '4px',
      display: 'block',
    };

    const helperStyle = {
      fontSize: '9px',
      color: '#9ca3af',
      marginTop: '2px',
    };

    const cardStyle = {
      backgroundColor: 'white',
      borderRadius: '12px',
      padding: '12px',
      marginBottom: '10px',
      boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
    };

    return (
      <div key="revenue-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.cream }}>
        {/* Header */}
        <div style={{ padding: '16px', background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button onClick={() => setCurrentScreen('main')} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {Icons.arrowLeft('white', 16)}
            </button>
            {Icons.dollar('white', 24)}
            <div>
              <h1 style={{ fontSize: '18px', fontWeight: '900', color: 'white', margin: 0 }}>Revenue Simulator</h1>
              <p style={{ fontSize: '10px', color: 'rgba(255,255,255,0.7)', margin: 0 }}>Admin Mode - Model your business financials</p>
            </div>
          </div>
        </div>

        {/* Content - Two Column Layout */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>

            {/* LEFT COLUMN - INPUTS */}
            <div>
              <h3 style={{ fontSize: '12px', fontWeight: '800', color: colors.navy, margin: '0 0 10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Inputs</h3>

              {/* Number of Venues */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle}>Number of Venues</label>
                <input
                  type="number"
                  value={numVenues}
                  onChange={(e) => setNumVenues(Math.max(0, parseInt(e.target.value) || 0))}
                  style={inputStyle}
                  min="0"
                />
                <p style={helperStyle}>Venues subscribed to Flock</p>
              </div>

              {/* Subscription Price */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle}>Monthly Subscription</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', fontWeight: '600' }}>$</span>
                  <input
                    type="number"
                    value={subscriptionPrice}
                    onChange={(e) => setSubscriptionPrice(Math.max(0, parseInt(e.target.value) || 0))}
                    style={{ ...inputStyle, paddingLeft: '28px' }}
                    min="0"
                  />
                </div>
                <p style={helperStyle}>Monthly fee per venue</p>
              </div>

              {/* Events Per Venue */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle}>Events Per Venue/Month</label>
                <input
                  type="number"
                  value={eventsPerVenue}
                  onChange={(e) => setEventsPerVenue(Math.max(0, parseInt(e.target.value) || 0))}
                  style={inputStyle}
                  min="0"
                />
                <p style={helperStyle}>Avg bookings per venue</p>
              </div>

              {/* Average Spend */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle}>Avg Group Spend</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', fontWeight: '600' }}>$</span>
                  <input
                    type="number"
                    value={avgSpend}
                    onChange={(e) => setAvgSpend(Math.max(0, parseInt(e.target.value) || 0))}
                    style={{ ...inputStyle, paddingLeft: '28px' }}
                    min="0"
                  />
                </div>
                <p style={helperStyle}>Per event transaction</p>
              </div>

              {/* Take Rate */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle}>Transaction Take Rate</label>
                <div style={{ position: 'relative' }}>
                  <input
                    type="number"
                    value={takeRate}
                    onChange={(e) => setTakeRate(Math.max(0, parseFloat(e.target.value) || 0))}
                    style={{ ...inputStyle, paddingRight: '28px' }}
                    min="0"
                    step="0.1"
                  />
                  <span style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', fontWeight: '600' }}>%</span>
                </div>
                <p style={helperStyle}>% of each transaction</p>
              </div>

              {/* Operating Costs */}
              <div style={{ marginBottom: '12px' }}>
                <label style={labelStyle}>Monthly Operating Costs</label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', fontWeight: '600' }}>$</span>
                  <input
                    type="number"
                    value={operatingCosts}
                    onChange={(e) => setOperatingCosts(Math.max(0, parseInt(e.target.value) || 0))}
                    style={{ ...inputStyle, paddingLeft: '28px' }}
                    min="0"
                  />
                </div>
                <p style={helperStyle}>Fixed monthly expenses</p>
              </div>
            </div>

            {/* RIGHT COLUMN - OUTPUTS */}
            <div>
              <h3 style={{ fontSize: '12px', fontWeight: '800', color: colors.navy, margin: '0 0 10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Results</h3>

              {/* Revenue Breakdown */}
              <div style={cardStyle}>
                <h4 style={{ fontSize: '10px', fontWeight: '700', color: '#6b7280', margin: '0 0 8px', textTransform: 'uppercase' }}>Revenue Breakdown</h4>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <span style={{ fontSize: '11px', color: '#6b7280' }}>Subscriptions</span>
                  <span style={{ fontSize: '11px', fontWeight: '600', color: colors.navy }}>{formatCurrency(subscriptionRevenue)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ fontSize: '11px', color: '#6b7280' }}>Transactions</span>
                  <span style={{ fontSize: '11px', fontWeight: '600', color: colors.navy }}>{formatCurrency(transactionRevenue)}</span>
                </div>
                <div style={{ borderTop: `1px solid ${colors.creamDark}`, paddingTop: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '12px', fontWeight: '700', color: colors.navy }}>Monthly Total</span>
                    <span style={{ fontSize: '18px', fontWeight: '900', color: colors.navy }}>{formatCurrency(totalMonthlyRevenue)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                    <span style={{ fontSize: '10px', color: '#6b7280' }}>Annual (ARR)</span>
                    <span style={{ fontSize: '12px', fontWeight: '700', color: colors.navyMid }}>{formatCurrency(annualRevenue)}</span>
                  </div>
                </div>
              </div>

              {/* Profitability */}
              <div style={{ ...cardStyle, background: isProfitable ? 'linear-gradient(135deg, #d1fae5, #a7f3d0)' : 'linear-gradient(135deg, #fee2e2, #fecaca)' }}>
                <h4 style={{ fontSize: '10px', fontWeight: '700', color: isProfitable ? '#047857' : '#b91c1c', margin: '0 0 8px', textTransform: 'uppercase' }}>
                  {isProfitable ? 'Profitable' : 'Not Profitable'}
                </h4>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', color: isProfitable ? '#065f46' : '#991b1b' }}>Monthly Profit</span>
                  <span style={{ fontSize: '16px', fontWeight: '900', color: isProfitable ? '#047857' : '#b91c1c' }}>
                    {monthlyProfit >= 0 ? '+' : ''}{formatCurrency(monthlyProfit)}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                  <span style={{ fontSize: '10px', color: isProfitable ? '#065f46' : '#991b1b' }}>Profit Margin</span>
                  <span style={{ fontSize: '12px', fontWeight: '700', color: isProfitable ? '#047857' : '#b91c1c' }}>
                    {profitMargin.toFixed(1)}%
                  </span>
                </div>
              </div>

              {/* Unit Economics */}
              <div style={cardStyle}>
                <h4 style={{ fontSize: '10px', fontWeight: '700', color: '#6b7280', margin: '0 0 8px', textTransform: 'uppercase' }}>Unit Economics</h4>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <span style={{ fontSize: '11px', color: '#6b7280' }}>Revenue/Venue</span>
                  <span style={{ fontSize: '11px', fontWeight: '600', color: colors.navy }}>{formatCurrency(revenuePerVenue)}/mo</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ fontSize: '11px', color: '#6b7280' }}>Break-Even Point</span>
                  <span style={{ fontSize: '11px', fontWeight: '600', color: colors.navy }}>{breakEvenVenues} venues</span>
                </div>
                <div style={{ padding: '8px', borderRadius: '8px', backgroundColor: isAboveBreakEven ? '#d1fae5' : '#fef3c7', textAlign: 'center' }}>
                  <span style={{ fontSize: '10px', fontWeight: '700', color: isAboveBreakEven ? '#047857' : '#b45309' }}>
                    {isAboveBreakEven
                      ? `${numVenues - breakEvenVenues} venues above break-even`
                      : `Need ${breakEvenVenues - numVenues} more venues`}
                  </span>
                </div>
              </div>

              {/* Business Model Info */}
              <div style={{ ...cardStyle, backgroundColor: colors.cream, border: `1px solid ${colors.creamDark}` }}>
                <h4 style={{ fontSize: '10px', fontWeight: '700', color: colors.navy, margin: '0 0 6px' }}>Business Model</h4>
                <p style={{ fontSize: '9px', color: '#6b7280', margin: 0, lineHeight: '1.4' }}>
                  Flock generates revenue through <strong>venue subscriptions</strong> (recurring, predictable)
                  and <strong>transaction fees</strong> (scales with activity). This dual-revenue model provides
                  stability while capturing upside from platform growth.
                </p>
              </div>
            </div>
          </div>
        </div>

        <BottomNav />
      </div>
    );
  };

  // RENDER - Call functions directly instead of JSX to prevent component recreation
  const renderScreen = () => {
    if (currentScreen === 'create') return CreateScreen();
    if (currentScreen === 'join') return JoinScreen();
    if (currentScreen === 'detail') return FlockDetailScreen();
    if (currentScreen === 'chatDetail') return ChatDetailScreen();
    if (currentScreen === 'venueDashboard') return <VenueDashboard />;
    if (currentScreen === 'adminRevenue') return <RevenueScreen />;
    switch (currentTab) {
      case 'explore': return ExploreScreen();
      case 'calendar': return CalendarScreen();
      case 'chat': return ChatListScreen();
      case 'profile': return ProfileScreen();
      default: return HomeScreen();
    }
  };

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#1a1a2e', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', boxSizing: 'border-box', fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}>
      <div style={styles.phoneContainer}>
        <div style={styles.notch}>
          <div style={styles.notchInner} />
        </div>
        <div style={styles.content}>
          {renderScreen()}
        </div>
      </div>
      <Toast />
      <SOSModal />
      <CheckinModal />
      <ProfilePicModal />
      <AIAssistantModal />
      <AdminPromptModal />
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
        @keyframes pulse {
          0%, 100% { opacity: 0.4; transform: translate(-50%, -50%) scale(1); }
          50% { opacity: 0.8; transform: translate(-50%, -50%) scale(1.2); }
        }
        @keyframes bounce {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-4px); }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes glow {
          0%, 100% { box-shadow: 0 0 5px rgba(13,40,71,0.3); }
          50% { box-shadow: 0 0 20px rgba(13,40,71,0.5); }
        }
        * {
          box-sizing: border-box;
          -webkit-tap-highlight-color: transparent;
        }
        body {
          margin: 0;
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
        }
        input:focus, textarea:focus {
          border-color: #0d2847 !important;
          box-shadow: 0 0 0 3px rgba(13,40,71,0.1) !important;
        }
        button:active {
          transform: scale(0.98);
        }
        ::-webkit-scrollbar {
          width: 4px;
        }
        ::-webkit-scrollbar-track {
          background: transparent;
        }
        ::-webkit-scrollbar-thumb {
          background: rgba(13,40,71,0.2);
          border-radius: 2px;
        }
      `}</style>
    </div>
  );
};

export default FlockApp;
