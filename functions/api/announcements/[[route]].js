2026-07-17T13:37:52.523428Z	Cloning repository...
2026-07-17T13:37:53.543335Z	From https://github.com/baderbouresly-commits/ghaya-suite
2026-07-17T13:37:53.543671Z	 * branch            dd2d60b22f065530a98c2c9ae0d5c20dc1025551 -> FETCH_HEAD
2026-07-17T13:37:53.543794Z	
2026-07-17T13:37:53.559373Z	HEAD is now at dd2d60b Create [[route]].js
2026-07-17T13:37:53.559628Z	
2026-07-17T13:37:53.595798Z	
2026-07-17T13:37:53.596077Z	Using v2 root directory strategy
2026-07-17T13:37:53.607143Z	Success: Finished cloning repository files
2026-07-17T13:37:53.543335Z	From https://github.com/baderbouresly-commits/ghaya-suite
2026-07-17T13:37:53.543671Z	 * branch            dd2d60b22f065530a98c2c9ae0d5c20dc1025551 -> FETCH_HEAD
2026-07-17T13:37:53.543794Z	
2026-07-17T13:37:53.559373Z	HEAD is now at dd2d60b Create [[route]].js
2026-07-17T13:37:53.559628Z	
2026-07-17T13:37:53.595798Z	
2026-07-17T13:37:53.596077Z	Using v2 root directory strategy
2026-07-17T13:37:53.607143Z	Success: Finished cloning repository files
2026-07-17T13:37:54.691175Z	No build output detected to cache. Skipping.
2026-07-17T13:37:54.691591Z	No dependencies detected to cache. Skipping.
2026-07-17T13:37:55.592634Z	Checking for configuration in a Wrangler configuration file (BETA)
2026-07-17T13:37:55.593113Z	
2026-07-17T13:37:55.593330Z	Found wrangler.toml file. Reading build configuration...
2026-07-17T13:37:55.600291Z	pages_build_output_dir: public
2026-07-17T13:37:55.600499Z	Build environment variables: 
2026-07-17T13:37:55.600571Z	  - ENVIRONMENT: production
2026-07-17T13:37:55.600629Z	  - JWT_SECRET: ghaya2025xK9mP3nQ7rL2sT8vW4yZ6aB1cD5eF0hJ
2026-07-17T13:37:55.600684Z	  - JWT_EXPIRES_IN: 86400
2026-07-17T13:37:55.600741Z	  - APP_NAME: Ghaya Suite
2026-07-17T13:37:55.600842Z	  - SUPPORT_EMAIL: support@ghaya.hr
2026-07-17T13:37:55.601429Z	  - ONESIGNAL_APP_ID: ded12bcc-da9a-4dca-b800-c7d3622ef474
2026-07-17T13:37:55.760537Z	Successfully read the Wrangler configuration file.
2026-07-17T13:37:55.761015Z	No build command specified. Skipping build step.
2026-07-17T13:37:55.761602Z	Found Functions directory at /functions. Uploading.
2026-07-17T13:37:55.766480Z	 ⛅️ wrangler 3.114.17
2026-07-17T13:37:55.766690Z	-------------------
2026-07-17T13:37:56.702835Z	[31m✘ [41;31m[[41;97mERROR[41;31m][0m [1mBuild failed with 1 error:[0m
2026-07-17T13:37:56.703262Z	
2026-07-17T13:37:56.703356Z	  [31m✘ [41;31m[[41;97mERROR[41;31m][0m [1mCould not resolve "../_lib/auth.js"[0m
2026-07-17T13:37:56.703426Z	  
2026-07-17T13:37:56.703470Z	      announcements/[[route]].js:2:41:
2026-07-17T13:37:56.703508Z	  [37m      2 │ import { requireAuth, json, error } from [32m'../_lib/auth.js'[37m;
2026-07-17T13:37:56.703543Z	          ╵                                          [32m~~~~~~~~~~~~~~~~~[0m
2026-07-17T13:37:56.703575Z	  
2026-07-17T13:37:56.703605Z	  
2026-07-17T13:37:56.703638Z	
2026-07-17T13:37:56.703779Z	
2026-07-17T13:37:56.706124Z	
2026-07-17T13:37:56.707962Z	[31m✘ [41;31m[[41;97mERROR[41;31m][0m [1mBuild failed with 1 error:[0m
2026-07-17T13:37:56.708048Z	
2026-07-17T13:37:56.708093Z	  [31m✘ [41;31m[[41;97mERROR[41;31m][0m [1mCould not resolve "../_lib/auth.js"[0m
2026-07-17T13:37:56.708131Z	  
2026-07-17T13:37:56.708166Z	      announcements/[[route]].js:2:41:
2026-07-17T13:37:56.708204Z	  [37m      2 │ import { requireAuth, json, error } from [32m'../_lib/auth.js'[37m;
2026-07-17T13:37:56.708330Z	          ╵                                          [32m~~~~~~~~~~~~~~~~~[0m
2026-07-17T13:37:56.708390Z	  
2026-07-17T13:37:56.708426Z	  
2026-07-17T13:37:56.708458Z	
2026-07-17T13:37:56.708489Z	
2026-07-17T13:37:56.716467Z	🪵  Logs were written to "/root/.config/.wrangler/logs/wrangler-2026-07-17_13-37-56_298.log"
2026-07-17T13:37:56.794570Z	Failed building Pages Functions.
2026-07-17T13:37:57.480188Z	Failed: generating Pages Functions failed. Check the logs above for more information. If this continues for an unknown reason, contact support: https://cfl.re/3WgEyrH
