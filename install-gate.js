/* =====================================================================
   QLog Pro Ultimate - Installation Gate verification data
   ---------------------------------------------------------------------
   The values below are PLACEHOLDERS in source control. During the
   production build, GitHub Actions replaces them with a random salt and
   an iterated SHA-256 digest derived from the repository secret
   QLOG_INSTALLATION_PASSWORD.

   The plaintext Installation Password is NEVER stored in this file,
   in the repository, or anywhere in the deployed application.

   When the placeholders are still present (local/dev copy) the
   installation gate is skipped, because there is nothing to verify
   against.
   ===================================================================== */
window.QLOG_INSTALL_GATE = {
  v: 1,
  s: "__QLOG_GATE_SALT__",
  h: "__QLOG_GATE_HASH__",
  i: 0,
  built: "__QLOG_GATE_BUILT__"
};
