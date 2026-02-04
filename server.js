const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve punnett data file
app.get('/punnettsquaredata.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'punnettsquaredata.js'));
});

// Store active rooms and players
const rooms = new Map();
const players = new Map();
const inactiveRooms = new Set(); // Track rooms that have been abandoned

// Game state management
const gameStates = new Map(); // roomCode -> gameState

// Load Punnett Square Pool from back-end file
const punnettData = require('./punnettsquaredata.js');
const PUNNETT_POOL = punnettData.PUNNETT_POOL;

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // Handle room creation
  socket.on('create-room', (playerName) => {
    const roomCode = generateRoomCode();
    rooms.set(roomCode, {
      players: [socket.id],
      playerNames: [playerName],
      gameStarted: false
    });
    players.set(socket.id, { room: roomCode, name: playerName });

    socket.join(roomCode);
    socket.emit('room-created', roomCode);
    console.log(`Room ${roomCode} created by ${playerName}`);
  });

  // Handle room ready (when 2 players join)
  socket.on('room-ready', () => {
    const playerData = players.get(socket.id);
    if (!playerData) return;

    const room = rooms.get(playerData.room);
    if (!room || room.players.length !== 2) return;

    // Initialize game state
    gameStates.set(playerData.room, {
      punnettPool: [...PUNNETT_POOL],
      currentQuestion: null,
      timeLeft: 30,
      roundActive: false,
      playerHP: {
        [room.playerNames[0]]: 100,
        [room.playerNames[1]]: 100
      },
      playerCorrects: {
        [room.playerNames[0]]: 0,
        [room.playerNames[1]]: 0
      },
      playerHealUsed: {
        [room.playerNames[0]]: false,
        [room.playerNames[1]]: false
      },
      playerDoubleDamageUsed: {
        [room.playerNames[0]]: false,
        [room.playerNames[1]]: false
      },
      playerDoubleDamageActive: {
        [room.playerNames[0]]: false,
        [room.playerNames[1]]: false
      },
      playerAnswers: {},
      stealTimeout: null,
      countdownInterval: null,
      timerInterval: null
    });

    // Notify all players in room that room is ready
    io.to(playerData.room).emit('room-ready', { playerNames: room.playerNames });

    // Start countdown
    const gameState = gameStates.get(playerData.room);
    let countdown = 3;
    io.to(playerData.room).emit('countdown-update', countdown);
    gameState.countdownInterval = setInterval(() => {
      countdown--;
      if (countdown >= 0) {
        io.to(playerData.room).emit('countdown-update', countdown);
      } else {
        clearInterval(gameState.countdownInterval);
        gameState.countdownInterval = null;
        io.to(playerData.room).emit('countdown-ended');
        // Start the game
        nextQuestion(playerData.room);
      }
    }, 1000);
  });

  // Handle joining room
  socket.on('join-room', (data) => {
    const { roomCode, playerName } = data;

    // Check if room is inactive (has been abandoned)
    if (inactiveRooms.has(roomCode)) {
      inactiveRooms.delete(roomCode);
      // Reactivate the room for reuse by resetting it
      let room = rooms.get(roomCode);
      if (room) {
        room.players = [];
        room.playerNames = [];
        room.gameStarted = false;
      }
    }

    let room = rooms.get(roomCode);

    // If room doesn't exist, create it
    if (!room) {
      room = {
        players: [],
        playerNames: [],
        gameStarted: false
      };
      rooms.set(roomCode, room);
      console.log(`Room ${roomCode} created by ${playerName}`);
    }

    if (room.players.length >= 2) {
      socket.emit('room-full');
      return;
    }

    if (room.gameStarted) {
      socket.emit('game-already-started');
      return;
    }

    // Check for duplicate names (case-sensitive)
    if (room.playerNames.includes(playerName)) {
      socket.emit('duplicate-name');
      return;
    }

    room.players.push(socket.id);
    room.playerNames.push(playerName);
    players.set(socket.id, { room: roomCode, name: playerName });

    socket.join(roomCode);

    // Always emit room-joined for consistency
    socket.emit('room-joined', roomCode);

    // Notify other players in the room
    socket.to(roomCode).emit('player-joined', playerName);

  // If room is now full, notify both players
  if (room.players.length === 2) {
    io.to(roomCode).emit('room-ready', { playerNames: room.playerNames });

    // Initialize game state for the room
    gameStates.set(roomCode, {
      punnettPool: [...PUNNETT_POOL],
      currentQuestion: null,
      timeLeft: 30,
      roundActive: false,
      playerHP: {
        [room.playerNames[0]]: 100,
        [room.playerNames[1]]: 100
      },
      playerCorrects: {
        [room.playerNames[0]]: 0,
        [room.playerNames[1]]: 0
      },
      playerHealUsed: {
        [room.playerNames[0]]: false,
        [room.playerNames[1]]: false
      },
      playerDoubleDamageUsed: {
        [room.playerNames[0]]: false,
        [room.playerNames[1]]: false
      },
      playerDoubleDamageActive: {
        [room.playerNames[0]]: false,
        [room.playerNames[1]]: false
      },
      playerAnswers: {},
      stealTimeout: null,
      countdownInterval: null,
      timerInterval: null
    });

    // Start countdown
    const gameState = gameStates.get(roomCode);
    let countdown = 3;
    io.to(roomCode).emit('countdown-update', countdown);
    gameState.countdownInterval = setInterval(() => {
      countdown--;
      if (countdown >= 0) {
        io.to(roomCode).emit('countdown-update', countdown);
      } else {
        clearInterval(gameState.countdownInterval);
        gameState.countdownInterval = null;
        io.to(roomCode).emit('countdown-ended');
        // Start the game
        nextQuestion(roomCode);
      }
    }, 1000);
  }

    console.log(`${playerName} joined room ${roomCode}`);
  });

  // Handle leaving room
  socket.on('leave-room', () => {
    const playerData = players.get(socket.id);
    if (playerData) {
      const room = rooms.get(playerData.room);
      if (room) {
        // Stop any active timers for the room
        const gameState = gameStates.get(playerData.room);
        if (gameState) {
          if (gameState.countdownInterval) {
            clearInterval(gameState.countdownInterval);
            gameState.countdownInterval = null;
          }
          if (gameState.timerInterval) {
            clearInterval(gameState.timerInterval);
            gameState.timerInterval = null;
            // Emit timer update to 0 for remaining players
            io.to(playerData.room).emit('timer-update', 0);
          }
        }

        room.players = room.players.filter(id => id !== socket.id);
        room.playerNames = room.playerNames.filter(name => name !== playerData.name);

        // If there's one player left, the remaining player wins
        if (room.players.length === 1) {
          const remainingPlayerName = room.playerNames[0];
          const leavingPlayerName = playerData.name;
          const playerCorrects = { [remainingPlayerName]: 0, [leavingPlayerName]: 0 };
          socket.to(playerData.room).emit('game-over', { winner: remainingPlayerName, playerCorrects });
        }

        // Notify remaining players after game-over
        // socket.to(playerData.room).emit('player-left', playerData.name); // removed

        // Mark empty rooms as inactive for reuse and reset them
        if (room.players.length === 0) {
          inactiveRooms.add(playerData.room);
          gameStates.delete(playerData.room);
          // Reset the room for future reuse
          room.players = [];
          room.playerNames = [];
          room.gameStarted = false;
        }
      }
      // Leave the socket.io room
      socket.leave(playerData.room);
      // Keep player in players map so socket remains connected
    }
    console.log('User left room:', socket.id);
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    const playerData = players.get(socket.id);
    if (playerData) {
      const room = rooms.get(playerData.room);
      if (room) {
        // Stop any active timers for the room
        const gameState = gameStates.get(playerData.room);
        if (gameState) {
          if (gameState.countdownInterval) {
            clearInterval(gameState.countdownInterval);
            gameState.countdownInterval = null;
          }
          if (gameState.timerInterval) {
            clearInterval(gameState.timerInterval);
            gameState.timerInterval = null;
          }
        }

        room.players = room.players.filter(id => id !== socket.id);
        room.playerNames = room.playerNames.filter(name => name !== playerData.name);

        // If there's one player left, the remaining player wins
        if (room.players.length === 1) {
          const remainingPlayerName = room.playerNames[0];
          const leavingPlayerName = playerData.name;
          const playerCorrects = { [remainingPlayerName]: 0, [leavingPlayerName]: 0 };
          socket.to(playerData.room).emit('game-over', { winner: remainingPlayerName, playerCorrects });
        }

        // Mark empty rooms as inactive for reuse
        if (room.players.length === 0) {
          inactiveRooms.add(playerData.room);
          gameStates.delete(playerData.room);
        }
      }
      players.delete(socket.id);
    }
    console.log('User disconnected:', socket.id);
  });

  // Add more game events here as you implement them
  socket.on('start-game', () => {
    const playerData = players.get(socket.id);
    if (playerData) {
      const room = rooms.get(playerData.room);
      if (room && room.players.length === 2) {
        room.gameStarted = true;
        io.to(playerData.room).emit('game-started');
      }
    }
  });

  // Handle skill usage
  socket.on('use-skill', (skillId) => {
    const playerData = players.get(socket.id);
    if (!playerData) return;

    const roomCode = playerData.room;
    const gameState = gameStates.get(roomCode);
    if (!gameState) return;

    if (skillId === 'p1heal' || skillId === 'p2heal') {
      // Check if heal has already been used this match
      if (gameState.playerHealUsed[playerData.name]) {
        return; // Heal already used, ignore
      }

      // Mark heal as used
      gameState.playerHealUsed[playerData.name] = true;

      // Healing logic: add 20 HP, cap at 100
      const currentHP = gameState.playerHP[playerData.name];
      const newHP = Math.min(100, currentHP + 20);
      gameState.playerHP[playerData.name] = newHP;

      // Emit player healed event to all players in the room
      io.to(roomCode).emit('player-healed', {
        healedPlayer: playerData.name,
        newHP: newHP
      });

      // Emit heal used event to disable the button
      socket.emit('heal-used', skillId);

      // Announce to the other player
      const room = rooms.get(roomCode);
      if (room) {
        const otherPlayerName = room.playerNames[0] === playerData.name ? room.playerNames[1] : room.playerNames[0];
        const otherPlayerSocket = Array.from(io.sockets.sockets.values()).find(s => players.get(s.id)?.name === otherPlayerName);
        if (otherPlayerSocket) {
          otherPlayerSocket.emit('heal-announce', { playerName: playerData.name });
        }
      }
    } else if (skillId === 'p1doubledamage' || skillId === 'p2doubledamage') {
      // Check if double damage has already been used this match
      if (gameState.playerDoubleDamageUsed[playerData.name]) {
        return; // Double damage already used, ignore
      }

      // Mark double damage as used and active
      gameState.playerDoubleDamageUsed[playerData.name] = true;
      gameState.playerDoubleDamageActive[playerData.name] = true;

      // Emit double damage used event to disable the button
      socket.emit('double-damage-used', skillId);

      // Announce to the other player
      const room = rooms.get(roomCode);
      if (room) {
        const otherPlayerName = room.playerNames[0] === playerData.name ? room.playerNames[1] : room.playerNames[0];
        const otherPlayerSocket = Array.from(io.sockets.sockets.values()).find(s => players.get(s.id)?.name === otherPlayerName);
        if (otherPlayerSocket) {
          otherPlayerSocket.emit('double-damage-announce', { playerName: playerData.name });
        }
      }
    }
    // Add other skill logic here if needed (shield)
  });

  // Handle multiplayer answer submission
  socket.on('submit-answer', (answerIndex) => {
    const playerData = players.get(socket.id);
    if (!playerData) return;

    const roomCode = playerData.room;
    const gameState = gameStates.get(roomCode);
    if (!gameState || !gameState.roundActive) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    const isCorrect = answerIndex === gameState.currentQuestion.correctIndex;
    const otherPlayerName = room.playerNames[0] === playerData.name ? room.playerNames[1] : room.playerNames[0];

    // Record the player's answer
    gameState.playerAnswers[playerData.name] = { answerIndex, isCorrect };

    // Emit highlight to the answering player
    socket.emit('highlight-answer', {
      correctIndex: gameState.currentQuestion.correctIndex,
      selectedIndex: answerIndex,
      playerName: playerData.name
    });

// Show visual to the answering player
if (isCorrect) {
  socket.emit('show-correct-visual');
  // Increment correct count
  gameState.playerCorrects[playerData.name]++;
  // Announce to the other player
  socket.to(roomCode).emit('show-match-announce', { playerName: playerData.name });

  // End the round immediately
  clearInterval(gameState.timerInterval);
  gameState.timerInterval = null;
  if (gameState.stealTimeout) {
    clearTimeout(gameState.stealTimeout);
    gameState.stealTimeout = null;
  }

  // Damage the other player (20 if double damage active, else 10)
  const damage = gameState.playerDoubleDamageActive[playerData.name] ? 20 : 10;
  gameState.playerHP[otherPlayerName] = Math.max(0, gameState.playerHP[otherPlayerName] - damage);
  io.to(roomCode).emit('player-damaged', {
    damagedPlayer: otherPlayerName,
    newHP: gameState.playerHP[otherPlayerName]
  });

  // Invalidate double damage after use
  gameState.playerDoubleDamageActive[playerData.name] = false;

  // Check if other player is defeated
  if (gameState.playerHP[otherPlayerName] <= 0) {
    io.to(roomCode).emit('game-over', { winner: playerData.name, playerCorrects: gameState.playerCorrects });
    return;
  }

  // Reset for next round
  gameState.playerAnswers = {};
  gameState.roundActive = false;

  // Load next question after delay
  setTimeout(() => {
    nextQuestion(roomCode);
  }, 2000);
} else {
  socket.emit('show-wrong-visual');
  socket.emit('disable-options'); // Disable options for the wrong player

  // Invalidate double damage on wrong answer
  gameState.playerDoubleDamageActive[playerData.name] = false;

  // Check if both players have answered
  const answeredPlayers = Object.keys(gameState.playerAnswers);
  if (answeredPlayers.length === 2) {
    // Both have answered, process results
    clearInterval(gameState.timerInterval);
    gameState.timerInterval = null;
    if (gameState.stealTimeout) {
      clearTimeout(gameState.stealTimeout);
      gameState.stealTimeout = null;
    }
    processRoundResults(roomCode);
  } else {
    // Wrong answer, give steal opportunity to the other player
    gameState.timeLeft += 5; // Add 5 seconds
    io.to(roomCode).emit('timer-update', gameState.timeLeft); // Update timer display

    // Send to the answering player
    socket.emit('show-steal-announce', { message: `You answered wrong, ${otherPlayerName} has now chance to steal!` });

    // Send to the other player
    socket.to(roomCode).emit('show-steal-announce', { message: `${playerData.name} answer is wrong, you have a chance to steal!` });

    // Question stays the same, timer continues
  }
}
  });
});



function processRoundResults(roomCode) {
  const gameState = gameStates.get(roomCode);
  if (!gameState) return;

  const room = rooms.get(roomCode);
  if (!room) return;

  const playerNames = room.playerNames;
  const answers = gameState.playerAnswers;

  const player1Correct = answers[playerNames[0]]?.isCorrect || false;
  const player2Correct = answers[playerNames[1]]?.isCorrect || false;

  if (player1Correct && player2Correct) {
    // Both correct, no damage
    gameState.playerCorrects[playerNames[0]]++;
    gameState.playerCorrects[playerNames[1]]++;
  } else if (player1Correct && !player2Correct) {
    // Player 1 correct, damage Player 2
    gameState.playerCorrects[playerNames[0]]++;
    const damage = gameState.playerDoubleDamageActive[playerNames[0]] ? 20 : 10;
    gameState.playerHP[playerNames[1]] = Math.max(0, gameState.playerHP[playerNames[1]] - damage);
    io.to(roomCode).emit('player-damaged', {
      damagedPlayer: playerNames[1],
      newHP: gameState.playerHP[playerNames[1]]
    });
    // Announce to Player 2
    io.to(roomCode).emit('show-match-announce', { playerName: playerNames[0] });
  } else if (!player1Correct && player2Correct) {
    // Player 2 correct, damage Player 1
    gameState.playerCorrects[playerNames[1]]++;
    const damage = gameState.playerDoubleDamageActive[playerNames[1]] ? 20 : 10;
    gameState.playerHP[playerNames[0]] = Math.max(0, gameState.playerHP[playerNames[0]] - damage);
    io.to(roomCode).emit('player-damaged', {
      damagedPlayer: playerNames[0],
      newHP: gameState.playerHP[playerNames[0]]
    });
    // Announce to Player 1
    io.to(roomCode).emit('show-match-announce', { playerName: playerNames[1] });
} else {
  // Both wrong, both lose 5 HP
  gameState.playerHP[playerNames[0]] = Math.max(0, gameState.playerHP[playerNames[0]] - 5);
  gameState.playerHP[playerNames[1]] = Math.max(0, gameState.playerHP[playerNames[1]] - 5);
  io.to(roomCode).emit('player-damaged', {
    damagedPlayer: playerNames[0],
    newHP: gameState.playerHP[playerNames[0]]
  });
  io.to(roomCode).emit('player-damaged', {
    damagedPlayer: playerNames[1],
    newHP: gameState.playerHP[playerNames[1]]
  });
  // Announce to both players
  io.to(roomCode).emit('show-both-wrong-announce');
}

  // Check for game over
  if (gameState.playerHP[playerNames[0]] <= 0 && gameState.playerHP[playerNames[1]] <= 0) {
    // Both defeated, maybe tie or something, but for now, no winner
    io.to(roomCode).emit('game-over', { winner: null, playerCorrects: gameState.playerCorrects });
    return;
  } else if (gameState.playerHP[playerNames[0]] <= 0) {
    io.to(roomCode).emit('game-over', { winner: playerNames[1], playerCorrects: gameState.playerCorrects });
    return;
  } else if (gameState.playerHP[playerNames[1]] <= 0) {
    io.to(roomCode).emit('game-over', { winner: playerNames[0], playerCorrects: gameState.playerCorrects });
    return;
  }

  // Reset for next round
  gameState.playerAnswers = {};
  gameState.roundActive = false;

  // Load next question after delay
  setTimeout(() => {
    nextQuestion(roomCode);
  }, 2000);
}

function nextQuestion(roomCode) {
  const gameState = gameStates.get(roomCode);
  if (!gameState) return;

  // Clear any existing timer interval to prevent multiple timers
  if (gameState.timerInterval) {
    clearInterval(gameState.timerInterval);
    gameState.timerInterval = null;
  }

  if (gameState.punnettPool.length === 0) {
    // Game over
    io.to(roomCode).emit('game-over');
    return;
  }

  // Reset player answers for new round
  gameState.playerAnswers = {};

  // Select a random question from the pool
  const randomIndex = Math.floor(Math.random() * gameState.punnettPool.length);
  const question = gameState.punnettPool.splice(randomIndex, 1)[0];
  gameState.currentQuestion = question;
  gameState.timeLeft = 30;
  gameState.roundActive = true;

  io.to(roomCode).emit('next-question', question);
  io.to(roomCode).emit('enable-options'); // Enable options for all players on new question

  gameState.timerInterval = setInterval(() => {
    if (gameState.timeLeft > 0) {
      gameState.timeLeft--;
      io.to(roomCode).emit('timer-update', gameState.timeLeft);
    } else {
      io.to(roomCode).emit('timer-update', 0);
      clearInterval(gameState.timerInterval);
      gameState.timerInterval = null;
      gameState.roundActive = false;

      // Both players lose 5 HP for not answering in time
      const room = rooms.get(roomCode);
      if (room) {
        const playerNames = room.playerNames;
        gameState.playerHP[playerNames[0]] = Math.max(0, gameState.playerHP[playerNames[0]] - 5);
        gameState.playerHP[playerNames[1]] = Math.max(0, gameState.playerHP[playerNames[1]] - 5);
        io.to(roomCode).emit('player-damaged', {
          damagedPlayer: playerNames[0],
          newHP: gameState.playerHP[playerNames[0]]
        });
        io.to(roomCode).emit('player-damaged', {
          damagedPlayer: playerNames[1],
          newHP: gameState.playerHP[playerNames[1]]
        });

        // Check for game over
        if (gameState.playerHP[playerNames[0]] <= 0 && gameState.playerHP[playerNames[1]] <= 0) {
          io.to(roomCode).emit('game-over', { winner: null, playerCorrects: gameState.playerCorrects });
          return;
        } else if (gameState.playerHP[playerNames[0]] <= 0) {
          io.to(roomCode).emit('game-over', { winner: playerNames[1], playerCorrects: gameState.playerCorrects });
          return;
        } else if (gameState.playerHP[playerNames[1]] <= 0) {
          io.to(roomCode).emit('game-over', { winner: playerNames[0], playerCorrects: gameState.playerCorrects });
          return;
        }
      }

      // Load next question after delay
      setTimeout(() => {
        nextQuestion(roomCode);
      }, 2000);
    }
  }, 1000);
}

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in multiple tabs to test multiplayer`);
});
