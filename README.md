
1. alexa-fhem installieren
  alexa-fhem-0.0.0.tgz auspacken
  package in alexa-fhem umbenennen
  cd alexa-fhem
  npm install
  ssl zertifikat mit ./createKey.sh erzeugen.
    -> password mindestens 4 stellen, alle fregen beantworten
  <home>/.alexa/config.json anpassen (siehe config-sample.json)
    client id -> (aus 3.1)
  bin/alexa starten

2. port 3000 von aussen erreichbar machen

3. alexa smart home skill anlegen
  amazon developer account anlegen
  bei developer.amazon.com anmelden
  3.1 apps&services
    security profiles
      create a new security profile
      [save]
    login with amazon
      profil von eben auswählen
      consent url -> https://www.amazon.com/gp/help/customer/display.html?nodeId=468496
    security profiles
      web settings
        allowed return urls -> https://layla.amazon.co.uk/api/skill/link/<xxx>
                               https://pitangui.amazon.com/api/skill/link/<xxx>
                               https://layla.amazon.com/api/skill/link/<xxx>
          <xxx> aus 3.2 configuration -> account linking -> redirect urls

  3.2 alexa
    alexa skills kit get started
    add a new skill
      skill information
        type -> smart home skill api
        language -> german
        [next]
        [next]
      configuration
        europe -> arn:aws:lambda... (aus 4.)
        authorization url -> https://www.amazon.com/ap/oa
        client id -> (aus 3.1)
        scope -> profile:user_id
        access token uri -> https://api.amazon.com/auth/o2/token
        client secret -> (aus 3.1)
        privacy policy url -> https://www.amazon.com/gp/help/customer/display.html?nodeId=468496
        [next]
      test
        show this skill in the alexa app -> yes
        [save]

4. aws lambda funktion anlegen
  aws.amazon.com account anlegen
  an der aws konsole anmelden
  lambda auswählen
  rechts oben -> eu (ireland)
  create lambda function
    select blueprint
      filter -> alexa -> 'alexa-smart-home-skill-adapter'
    configure triggers
      aplication id -> amzn1.ask.skil... (aus 3.2 Skill Information)
      enable trigger -> ja
      [next]
    configure function
      name -> FHEM
      runtime -> Node.js 4.3
      edit code inline -> lambda.js einfügen, hostname (mein.host.name) anpassen -> save
      role -> Existing role
      existing role-> service-role/myRoleName
      [next]
      [create function]

5. http://alexa.amazon.de
   -> skils -> meine skils (rechts oben) -> fhem skill hinzufügen -> mit eigenem amazon konto anmelden

   “alexa, finde meine smarten geräte“
     oder
   -> smart home -> geräte suchen

   optional: gruppen (räume) anlegen

6. “alexa, schalte <gerät> ein”
   “alexa, schalte <gerät> aus”
   “alexa, stelle <gerät> auf <wert> prozent”
   “alexa, stelle <gerät/raum> auf <anzahl> grad”
