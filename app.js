require('dotenv').config();

const { assertWebProductionConfig, isProductionRuntime } = require('./utils/productionRuntimeConfig');
assertWebProductionConfig(process.env);
const productionRuntime = isProductionRuntime(process.env);
const trustProxyHops = productionRuntime ? Number(process.env.TRUST_PROXY_HOPS) : 0;

const express = require('express');
const session = require('express-session');
const { SqliteSessionStore, resolveSessionDatabasePath } = require('./utils/sqliteSessionStore');
const path = require('path');
const db = require('./database');
const { getRolesDataFromDb } = require('./utils/dataSync');
const {
    getRoleInfo,
    getRoleBadgeInlineStyle,
    ROLE_BADGE_CLASS_MAP,
    ROLE_BADGE_INLINE_STYLE_MAP,
    DEFAULT_ROLE_BADGE_INLINE_STYLE
} = require('./utils/roleHelper');
const orderStatus = require('./utils/orderStatus');
const passport = require('./config/passport');
const { sameOriginGuard } = require('./middleware/csrf');
const { preventBackCache } = require('./middleware/preventBackCache');
const { initializationWindowGuard, isRbacInitializationWindow } = require('./middleware/initializationWindowGuard');
const { isPlatformSuperuserId, resolvePermissions, hasResolvedPermission } = require('./utils/permissionResolver');

const authRouter = require('./routes/auth');
const authEmailRouter = require('./routes/api/authEmail');
const withdrawalsRouter = require('./routes/api/withdrawals');
const userRouter = require('./routes/user');
const systemRouter = require('./routes/system');
const managementRouter = require('./routes/management');

const app = express();
if (productionRuntime) app.set('trust proxy', trustProxyHops);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.status(200).type('text/plain').send('ok'));

const sessionStore = productionRuntime ? new SqliteSessionStore({
    filename: resolveSessionDatabasePath(process.env),
    busyTimeout: Number(process.env.SQLITE_BUSY_TIMEOUT_MS)
}) : null;
if (sessionStore) sessionStore.on('error', () => console.error('Session storage maintenance failed.'));
app.locals.sessionStore = sessionStore;
app.locals.sessionStoreReady = sessionStore ? sessionStore.ready : Promise.resolve();

const sessionCookieName = 'connect.sid';
const sessionCookieOptions = {
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: productionRuntime
};
app.locals.sessionCookieName = sessionCookieName;
app.locals.sessionCookieOptions = sessionCookieOptions;

app.use(session({
    name: sessionCookieName,
    ...(sessionStore ? { store: sessionStore } : {}),
    secret: process.env.SESSION_SECRET || 'mihu_gaming_secret_2026',
    resave: false,
    saveUninitialized: false,
    cookie: sessionCookieOptions
}));

app.use(passport.initialize());
app.use(passport.session());
app.use(preventBackCache);
app.use(sameOriginGuard);

app.use((req, res, next) => {
    res.locals.getRoleInfo = getRoleInfo;
    res.locals.getRoleBadgeInlineStyle = getRoleBadgeInlineStyle;
    res.locals.roleBadgeClassMap = ROLE_BADGE_CLASS_MAP;
    res.locals.roleBadgeInlineStyleMap = ROLE_BADGE_INLINE_STYLE_MAP;
    res.locals.roleBadgeDefaultInlineStyle = DEFAULT_ROLE_BADGE_INLINE_STYLE;
    res.locals.orderStatus = orderStatus;
    res.locals.orderStatusFilters = orderStatus.getOrderStatusFilterOptions();
    res.locals.requestMethod = String(req.method || '').toUpperCase();

    if (req.isAuthenticated() && req.user) {
        db.get('SELECT * FROM users WHERE id = ?', [req.user.id], (userError, freshUser) => {
            const currentUser = freshUser || req.user;
            getRolesDataFromDb().then(rolesData => {
                const role = rolesData.find(item => item.role_key === currentUser.role);
                const storedPermissions = role && Array.isArray(role.permissions)
                    ? role.permissions
                    : ['view_dashboard', 'view_dashboard_wallet', 'view_dashboard_info', 'view_personal', 'view_profile', 'view_wallet', 'view_personal_orders'];
                const permissions = resolvePermissions(storedPermissions, isPlatformSuperuserId(currentUser.id));
                const isSuperuser = hasResolvedPermission(permissions, '*');
                db.get('SELECT id FROM studios WHERE id = ? AND owner_user_id = ?', [Number(currentUser.studio_id), currentUser.id], (studioError, ownedStudio) => {
                    res.locals.userPerms = permissions;
                    res.locals.currentUser = currentUser;
                    res.locals.user = currentUser;
                    res.locals.hasPerm = node => hasResolvedPermission(permissions, node);
                    res.locals.canManageStudioCommission = hasResolvedPermission(permissions, 'action_commission_config') || Boolean(ownedStudio);
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

if (isRbacInitializationWindow(process.env)) app.use(initializationWindowGuard);

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
