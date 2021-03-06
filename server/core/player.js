const config = require('./config');
const PF = require('pathfinding');
const emoji = require('node-emoji');
const world = require('./world');
const WebSocket = require('ws');
const UI = require('./utilities/ui');
const axios = require('axios');
const Socket = require('../socket');
const uuid = require('uuid/v4');
const { wearableItems } = require('./data/items');

class Player {
  constructor(data, token, socketId) {
    // Main statistics
    this.username = data.username;
    this.x = data.x;
    this.y = data.y;
    this.level = data.level;
    this.skills = data.skills;
    this.hp = {
      current: data.hp.current,
      max: data.hp.max,
    };

    // Worn items statistics
    this.combat = {
      attack: {
        stab: 0, slash: 0, crush: 0, range: 0,
      },
      defense: {
        stab: 0, slash: 0, crush: 0, range: 0,
      },
    };

    // Authentication
    this.moving = false;
    this.token = token;
    this.uuid = data.uuid;
    this.socket_id = socketId;

    // Tabs
    this.friend_list = data.friend_list;
    this.wear = Player.constructWear(data.wear);

    // Pathfinding
    this.path = {
      grid: null, // a 0/1 grid of blocked tiles
      finder: new PF.DijkstraFinder(),
      current: {
        name: '',
        length: 0, // Number of steps in current path
        path: {
          walking: [], // Current path walking
          set: [], // Current path from last walk-loop
        },
        step: 0, // Steps player has taken to walk
        walkable: false, // Did we click on a blocked tile?
        interrupted: false, // Did we click-to-walk elsewhere while walking current loop?
      },
    };

    // Action queue
    this.queue = [];

    // Player inventory
    this.inventory = [...data.inventory];

    console.log(`${emoji.get('high_brightness')}  Player ${this.username} (lvl ${this.level}) logged in. (${this.x}, ${this.y})`);
  }

  /**
   * Make up correct object format for Vue component
   * as it is abstracted from the database
   *
   * @param {string} data The item ID
   */
  static constructWear(data) {
    const wearData = data;
    // Do not load arrows for now
    delete wearData.arrows;

    // Go through every wear slot
    // and map from database to Vue object
    Object.keys(wearData).forEach((property) => {
      if (Object.prototype.hasOwnProperty.call(wearData, property)) {
        if (wearData[property] !== null) {
          const id = wearData[property];
          wearData[property] = {
            uuid: uuid(),
            graphics: wearableItems.find(db => db.id === id).graphics,
            id,
          };
        }
      }
    });

    return data;
  }

  /**
   * Move the player in a direction per a tile
   *
   * @param {string} direction The direction which the player is moving
   * @param {boolean} pathfind Whether pathfinding is being used to move player
   */
  move(direction, pathfind = false) {
    if (pathfind) {
      this.moving = true;
    }

    switch (direction) {
      default:
        console.log('Nothing happened');
        break;

      case 'right':
        if (!this.checkCollision(direction)) {
          this.x += 1;
        }
        break;

      case 'left':
        if (!this.checkCollision(direction)) {
          this.x -= 1;
        }
        break;

      case 'up':
        if (!this.checkCollision(direction)) {
          this.y -= 1;
        }
        break;

      case 'down':
        if (!this.checkCollision(direction)) {
          this.y += 1;
        }
        break;
    }
  }

  /**
   * Walk the player after a path is found
   *
   * @param {object} path The information to be used of the pathfind
   * @param {object} map The map object associated with player
   */
  walkPath(playerIndex) {
    const { path } = world.players[playerIndex];
    const speed = 150; // Delay to next step during walk

    // Immediately-invoked function expression (IIFE) for the setTimeout
    // so that the setTimeouts queue up and do not mix with each other
    (() => {
      setTimeout(() => {
        // If equal, it means our last step is the same as from
        // when our pathfinding first started, so we keep going.

        if ((path.current.step + 1) === path.current.path.walking.length) {
          // If they queue is not empty
          // let's do it after destination is reached
          if (!Player.queueEmpty(playerIndex)) {
            const todo = world.players[playerIndex].queue[0];

            // TODO
            // Abstract this to own file of action events in-game
            if (todo.action.name === 'Take') {
              // eslint-disable-next-line
              const itemToTake = world.items.findIndex(e => (e.x === todo.at.x) && (e.y === todo.at.y) && (e.uuid === todo.item.uuid));

              world.items.splice(itemToTake, 1);

              Socket.broadcast('item:change', world.items);

              console.log(`Picking up: ${todo.item.id} (${todo.item.uuid.substr(0, 5)}...)`);

              world.players[playerIndex].inventory.push({
                slot: UI.getOpenSlot(world.players[playerIndex].inventory),
                id: todo.item.id,
                uuid: todo.item.uuid,
              });

              const data = {
                player: { socket_id: world.players[playerIndex].socket_id },
                data: world.players[playerIndex].inventory,
              };

              // Tell client to update their inventory
              Socket.emit('item:pickup', data);
            }

            // Remove action from queue
            this.queue.shift();
          }

          this.stopMovement();
        } else {
          const steps = {
            current: {
              x: path.current.path.walking[path.current.step][0],
              y: path.current.path.walking[path.current.step][1],
            },
            next: {
              x: path.current.path.walking[path.current.step + 1][0],
              y: path.current.path.walking[path.current.step + 1][1],
            },
          };

          const movement = UI.getMovementDirection(steps);

          this.move(movement, true);

          const playerChanging = world.players[playerIndex];
          world.clients.forEach((client) => {
            if ((client.readyState === WebSocket.OPEN) && world.bus) {
              Socket.broadcast('player:movement', playerChanging);
            }
          });

          world.players[playerIndex].path.current.step += 1;

          if (path.current.step <= path.current.path.walking.length) {
            this.walkPath(playerIndex);
          }
        }
      }, speed);
    })();
  }

  /**
   * When player stops moving during pathfinding walking
   */
  stopMovement() {
    this.moving = false;
  }

  /**
   * Checks to see if player can continue walking
   *
   * @param map {object} The map object being passed
   * @param direction {string} The direction player is going
   * @returns {boolean}
   */
  checkCollision(direction) {
    const {
      size, viewport, tileset, objects,
    } = config.map;
    const tileCrop = {
      x: this.x - Math.floor(0.5 * viewport.x),
      y: this.y - Math.floor(0.5 * viewport.y),
    };

    const getY = (dirMove) => {
      if (dirMove === 'right' || dirMove === 'left') return 5;
      return dirMove === 'up' ? 4 : 6;
    };

    const getX = (dirMove) => {
      if (dirMove === 'up' || dirMove === 'down') return 7;
      return dirMove === 'left' ? 6 : 8;
    };

    const steppedOn = {
      // eslint-disable-next-line
      background: world.map.background[(((getY(direction) + tileCrop.y) * size.x) + getX(direction)) + tileCrop.x] - 1,
      // eslint-disable-next-line
      foreground: world.map.foreground[(((getY(direction) + tileCrop.y) * size.x) + getX(direction)) + tileCrop.x] - 1,
    };

    // eslint-disable-next-line
    const blocked = {
      background: tileset.blocked.includes(steppedOn.background),
      foreground: objects.blocked.includes((steppedOn.foreground - 252)),
    };

    return blocked.background || blocked.foreground;
  }

  /**
   * Player will perform an action
   *
   * @param {string} item Action to do
   */
  do(item) {
    console.log(this.x, this.y, `Doing ${item}`);
  }

  /**
   * Checks if player queue is  empty
   *
   * @returns {boolean}
   */
  static queueEmpty(playerIndex) {
    return world.players[playerIndex].queue.length === 0;
  }

  /**
   * Update the player profile in the database
   *
   * @return void
   */
  update() {
    const url = `${process.env.SITE_URL}/api/auth/update`;
    const reqConfig = {
      headers: { Authorization: `Bearer ${this.token}` },
    };

    // Find player on server
    const getPlayer = world.players
      .find(p => p.token === this.token);

    // Get player data
    const playerData = {
      x: getPlayer.x,
      y: getPlayer.y,
      username: getPlayer.username,
      hp_current: getPlayer.hp.current,
      hp_max: getPlayer.hp.max,
    };

    // Get inventory data
    const inventoryData = getPlayer.inventory;

    // Get wearable data
    const wearData = getPlayer.wear;

    Object.keys(wearData).forEach((property) => {
      if (Object.prototype.hasOwnProperty.call(wearData, property)) {
        wearData[property] = wearData[property] === null ? null : wearData[property].id;
      }
    });

    if (Object.prototype.hasOwnProperty.call(wearData, 'arrows')) {
      delete wearData.arrows;
    }

    const data = {
      uuid: this.uuid, playerData, inventoryData, wearData,
    };

    return new Promise((resolve) => {
      axios
        .post(url, data, reqConfig)
        .then((r) => {
          resolve(r.data);
        });
    });
  }
}

module.exports = Player;
