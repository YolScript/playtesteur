require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const cron = require('node-cron');

require('./src/db/init'); // initialise le schéma au démarrage
const { runMidnightJob } = require('./src/jobs/midnightJob');

const authRoutes = require('./src/routes/auth');
const profileRoutes = require('./src/routes/profile');
const appsRoutes = require('./src/routes/apps');
const adminRoutes = require('./src/routes/admin');
const classementRoutes = require('./src/routes/classement');
const ticketsRoutes = require('./src/routes/tickets');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 8090;

app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-a-changer',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }, // 30 jours
  })
);

app.use('/api/auth', authRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/apps', appsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/classement', classementRoutes);
app.use('/api/tickets', ticketsRoutes);

app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ erreur: 'Route API inconnue.' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Job de minuit : sanction d'inactivité + clôture des apps réciproques mortes.
cron.schedule('0 0 * * *', () => {
  runMidnightJob();
});

app.listen(PORT, () => {
  console.log(`[PlayTesteur] Serveur démarré sur http://localhost:${PORT}`);
});
