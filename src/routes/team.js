'use strict';

/**
 * Staff, roles, branches and POS terminals. Exports one router per group (terminals live at
 * /terminals, not under /branches).
 */
const express = require('express');
const { can, canAny } = require('../middleware');
const users = require('../controllers/userController');
const roles = require('../controllers/roleController');
const branches = require('../controllers/branchController');

// ---------- /users ----------
const usersRouter = express.Router();
usersRouter.use(can('users.manage'));
usersRouter.get('/', users.list);
usersRouter.post('/', users.create);
usersRouter.get('/:id', users.get);
usersRouter.patch('/:id', users.update);
usersRouter.post('/:id/reset-password', users.resetPassword);
usersRouter.put('/:id/pin', users.setPin);
usersRouter.post('/:id/deactivate', users.deactivate);

// ---------- /roles ----------
// The user editor needs to list roles, so users.manage may read them; only roles.manage may change them.
const rolesRouter = express.Router();
rolesRouter.get('/permissions', can('roles.manage'), roles.permissionCatalog); // before /:id
rolesRouter.get('/', canAny('users.manage', 'roles.manage'), roles.list);
rolesRouter.get('/:id', canAny('users.manage', 'roles.manage'), roles.get);
rolesRouter.post('/', can('roles.manage'), roles.create);
rolesRouter.patch('/:id', can('roles.manage'), roles.update);
rolesRouter.delete('/:id', can('roles.manage'), roles.remove);

// ---------- /branches ----------
// Listing is open to every logged-in user (the branch switcher needs it); the controller only shows
// branches the user may work in unless they manage branches.
const branchesRouter = express.Router();
branchesRouter.get('/', branches.list);
branchesRouter.post('/', can('branches.manage'), branches.create);
branchesRouter.get('/:id', branches.get);
branchesRouter.patch('/:id', can('branches.manage'), branches.update);
branchesRouter.post('/:id/main', can('branches.manage'), branches.setMain);
branchesRouter.get('/:id/terminals', canAny('branches.manage', 'pos.shift'), branches.listTerminals);
branchesRouter.post('/:id/terminals', can('branches.manage'), branches.createTerminal);

// ---------- /terminals ----------
const terminalsRouter = express.Router();
terminalsRouter.post('/heartbeat', canAny('pos.sell', 'pos.shift'), branches.terminalHeartbeat);
terminalsRouter.patch('/:id', can('branches.manage'), branches.updateTerminal);

module.exports = { usersRouter, rolesRouter, branchesRouter, terminalsRouter };
