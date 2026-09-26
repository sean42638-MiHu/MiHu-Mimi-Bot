const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./database');
const { getRolesDataFromDb } = require('./utils/dataSync');
const { getRoleInfo } = require('./utils/roleHelper');
const passport = require('./config/passport');
const { sameOriginGuard } = require('./middleware/csrf');

const authRouter = require('./routes/auth');
const authEmailRouter = require('./routes/api/authEmail');
const withdrawalsRouter = require('./routes/api/withdrawals');
const userRouter = require('./routes/user');
const systemRouter = require('./routes/system');
const managementRouter = require('./routes/management');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: process.env.SESSION_SECRET || 'mihu_gaming_secret_2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.use(passport.initialize());
app.use(passport.session());
app.use(sameOriginGuard);

app.use((req, res, next) => {
    res.locals.getRoleInfo = getRoleInfo;

    if (req.isAuthenticated() && req.user) {
        db.get('SELECT * FROM users WHERE id = ?', [req.user.id], (userError, freshUser) => {
            const currentUser = freshUser || req.user;
            getRolesDataFromDb().then(rolesData => {
                const role = rolesData.find(item => item.role_key === currentUser.role);
                const isSuperAdmin = currentUser.id === '604610298581876746' || currentUser.role === 'admin';
                const permissions = isSuperAdmin
                    ? [
                        'home', 'home_banner', 'home_wallet_card', 'home_info',
                        'personal', 'profile', 'profile_discord', 'profile_nickname', 'my_wallet', 'my_income', 'my_orders',
                        'manage', 'manage_members', 'member_adjust_balance', 'member_adjust_vip', 'manage_staff', 'manage_orders',
                        'system', 'sys_commission', 'sys_vip', 'sys_roles', 'sys_settings', 'sys_logs',
                        'payout.view', 'payout.view_sensitive', 'payout.export', 'payout.mark_paid', 'payout.reject'
                    ]
                    : (role && Array.isArray(role.permissions)
                        ? role.permissions
                        : ['home', 'home_wallet_card', 'home_info', 'personal', 'profile', 'my_wallet', 'my_orders']);

                db.get('SELECT id FROM studios WHERE id = ? AND owner_user_id = ?', [Number(currentUser.studio_id), currentUser.id], (studioError, ownedStudio) => {
                    res.locals.userPerms = permissions;
                    res.locals.currentUser = currentUser;
                    res.locals.user = currentUser;
                    res.locals.hasPerm = node => isSuperAdmin || permissions.includes(node);
                    res.locals.canManageStudioCommission = isSuperAdmin || permissions.includes('sys_commission') || Boolean(ownedStudio);
                    next();
                });
            }).catch(next);
        });
    } else {
        res.locals.userPerms = [];
        res.locals.currentUser = null;
        res.locals.user = null;
        res.locals.hasPerm = () => false;
        next();
    }
});

if (process.env.NODE_ENV === 'test' && process.env.TEST_AUTH_FIXTURE_ENABLED === 'true') {
    app.post('/__test/auth', (req, res, next) => {
        db.get('SELECT * FROM users WHERE id = ?', [req.body.userId], (error, user) => {
            if (error) return next(error);
            if (!user) return res.status(404).end();
            req.login(user, loginError => loginError ? next(loginError) : res.status(204).end());
        });
    });
}

app.use('/', authRouter);
app.use('/', authEmailRouter);
app.use('/', withdrawalsRouter);
app.use('/', userRouter);
app.use('/', systemRouter);
app.use('/management', managementRouter);

app.get('/', (req, res) => {
    res.redirect(req.isAuthenticated() ? '/dashboard' : '/login');
});

module.exports = app;
