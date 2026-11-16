<?php
// Storage-side configuration for list.php and manage.php. Copy to config.php in the same folder and edit.
// It only returns an array, so opening it in a browser shows nothing (and .htaccess / the Caddy config deny it anyway).
return [
  // Library folders: id => absolute path. The ids must match LIBRARY_ROOTS in the Worker config, and are part of
  // every file's id: never rename one once the library is built.
  'roots' => [
    'movies'  => '/home/USER/media/movies',
    'tv'      => '/home/USER/media/tv',
    'youtube' => '/home/USER/media/youtube',
  ],
  // Every root must be inside this folder. Deleted files go to <base>/.watch-trash (same filesystem: instant moves).
  'base' => '/home/USER/media',
  // Outside the web root: manage.key, htpasswd, caches. Mode 700.
  'private_dir' => '/home/USER/watchbox-private',
  // Disk usage for the admin page's storage meter:
  //   ['type' => 'none']   free/total space of the disk holding 'base' (a VPS, or any host without a panel)
  //   ['type' => 'directadmin', 'url' => 'https://panel.example.com:2222', 'user' => 'USER', 'key_file' => 'da-usage.key']
  //       a DirectAdmin login key allowed only CMD_API_SHOW_USER_USAGE (file in private_dir)
  //   ['type' => 'cpanel', 'url' => 'https://panel.example.com:2083', 'user' => 'USER', 'token_file' => 'cpanel.token']
  //       a cPanel API token (file in private_dir); uses UAPI Quota::get_quota_info
  'usage' => ['type' => 'none'],
];
