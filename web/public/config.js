// Tycoon server settings.
//
// Leave both empty to run the game as an offline sandbox (everything is
// saved in the player's own browser).
//
// For real multiplayer, create a free Supabase project, run
// supabase/setup.sql in its SQL editor, then paste the project URL and the
// publishable ("anon") key below. Both values are safe to publish: the
// database only lets this key call the game's own functions.
window.TYCOON_CONFIG = {
  supabaseUrl: '',
  supabaseKey: '',
};
