# TODO: Implement Double Damage Feature in Multiplayer

## Tasks
- [x] Add double damage state to server.js gameState (used and active flags)
- [x] Handle 'use-skill' for p1doubledamage/p2doubledamage in server.js: set active, announce, disable button
- [x] Modify damage logic in submit-answer to apply 20HP if active
- [x] Modify damage logic in processRoundResults to apply 20HP if active
- [x] In client.js, add event listeners for double damage buttons and handle announcements
- [x] Test in multiplayer to ensure correct damage and announcements
