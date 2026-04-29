Step-by-Step Setup                                                                                                                                   
                                                                                                                                                       
  1. Clone & Install
                                                                                                                                                       
  git clone <repo> && cd Portal_Git_Files 
  npm install                                                                                                                                          
                                          
  2. Create .env File                                                                                                                                  
                                          
  cp .env.example .env                                                                                                                                 
  Fill in all values (ask DevOps/admin for these):                                                                                                    - Variable / Where to Get It                                                                                                                        
- TABLEAU_CLIENT_ID / Tableau Server Admin → Connected Apps                                                                                          
- TABLEAU_SECRET_ID / Same Connected App                                                                                                              
- TABLEAU_SECRET_VALUE / Same Connected App
- TABLEAU_USER / Email of the service account that owns the Connected App                                                  
- TABLEAU_SERVER / Your Tableau Cloud URL (e.g. https://10az.online.tableau.com)                                                          
- TABLEAU_SITE / Site name from the Tableau URL
- TABLEAU_API / API version (e.g. 3.21)                                                        
- TABLEAU_PAT_NAME / Personal Access Token name (for MCP)                                                         
- TABLEAU_PAT_VALUE / Personal Access Token value (for MCP)                                                         
- SAFETY_METRIC_ID / UUID of the safety metric in Tableau Pulse                                                          
                                          
  3. Generate SSL Certificates (dev only)                                                                                                              
                                          
  openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes                                                                    
  The server runs on HTTPS port 5500 and requires these files.                                                                                         
                                                                                                                                                       
  4. Configure AWS Credentials                                                                                                                         
                                                                                                                                                       
  aws configure                           
  The account needs Bedrock access in us-west-2 to the model claude-opus-4-5.                                                                          
                                                                                                                                                       
  5. Start the Server                                                                                                                                  
                                                                                                                                                       
  chmod +x start.sh                       
  ./start.sh                                                                                                                                           
  This starts two processes:              
  - MCP proxy on http://localhost:3100                                                                                                                 
  - Express server on https://localhost:5500
                                                                                                                                                       
  6. Open in Browser                                                                                                                                   
                                                                                                                                                       
  https://localhost:5500                                                                                                                               
  Accept/bypass the self-signed certificate warning.                                                                                                   
                                                                                                                                                       
  ---                                                                                                                                                  
  Troubleshooting                                                                                                                                      
                                                                                                                                                       
  - SSL error on start: key.pem / cert.pem are missing — run the openssl command above.                                                                
  - MCP not starting: Verify Claude Desktop is installed and the Tableau extension path exists.                                                        
  - Tableau auth failing: Hit https://localhost:5500/debug-auth for a detailed diagnostic.                                                             
  - Claude/AI not working: Run aws bedrock list-foundation-models --region us-west-2 to verify Bedrock access.                                         
  - Port in use: Check ports 5500 and 3100 are free before starting.    
