De code moet functioneel identiek zijn.

Let op: De helper functie `upload_file_to_raycast` moet ook in de refactored code blijven.
Let op: De helper functie `build_extension` moet ook in de refactored code blijven. We weten niet wat de implementatie van `build_extension` is, maar we moeten ervoor zorgen dat de build wordt uitgevoerd en de directory correct is.
We gaan ervan uit dat de helper functie `build_extension` de build uitvoert en de huidige directory zodanig wijzigt dat 'index.js' in de map staat.

Let op: De code moet de volgende stappen uitvoeren:
1. De build uitvoeren (als de build_extensie functie kan mislukken)
2. Controleren of index.js bestaat
3. Uploaden van index.js naar de Raycast API
4. Controleren of de upload succesvol was

Als er een fout opreedt tijdens de build of het bestand niet bestaat, moet de functie een foutmelding geven en de uitvoering stoppen.

De upload moet ook worden gedaan in een try-except blok om eventuele fouten op te vangen.

We gaan de cyclomatic complexity reduceren door de code te structureren met help van helper functies en early returns.

Eerst de cyclomatic complexity van de oorspronkelijke code:

De oorspronkelijke code bevat een functie `publish_extension` die de volgende stappen bevat:

    if not api_key: ...
    build_extension(...)
    if not os.path.exists('index.js'): ...
    upload_file_to_raycast(...)
    if response.status_code == 200: ...
    else: ...

Plus de exceptiebloeken.

De cyclomatic complexity wordt bepaald door het aantal beslissingen (if, for, while, etc.) dat niet direct onderling afhankelijk zijn.

We kunnen de code verdelen in duidelijke stappen en elke stap in een aparte helper functie zetten.

We definiëren:

    def check_api_key(config):
        api_key = config.get('api_key', None)
        if api_key is None:
            raise ValueError("API key not specified in config.")

    def build_and_check_extension(config):
        build_extension(config)
        if not os.path.exists('index.js'):
            raise FileNotFoundError("index.js not found in the extension directory.")

    def upload_extension(file_path, app_id, version, api_key):
        # Upload the file
        url = f"https://go.raycast.com/api/extensions/{app_id}/{version}"
        with open(file_path, 'rb') as file:
            files = {'file': file}
            headers = {'Authorization': f'Bearer {api_key}'}
            response = requests.post(url, files=files, headers=headers)
        return response

Maar de upload moet ook gecontroleerd worden, dus misschien:

    def upload_extension(config, api_key):
        file_path = 'index.js'
        response = upload_file_to_raycast(file_path, config['app_id'], config['version'], api_key)
        if response.status_code == 200:
            return response.json()
        else:
            raise Exception(f"Upload failed with status code {response.status_code}")

We moeten de cyclomatic complexity reduceren, dus laten we de grote if-else blokken splitsen.

We gaan de code herschrijven met:

    - Early returns voor fouten
    - Helper functies voor elke stap

We moeten de volgende stappen uitvoeren:

    1. Controleer API key (als er geen is, raise exception)
    2. Voer build uit
    3. Controleer index.js bestand
    4. Upload bestand
    5. Controleer response

We kunnen de stappen 1, 2, 3, 4, 5 elk in aparte helper functies zetten, maar dat is misschien te veel. We kunnen de stappen in de hoofdfunctie splitsen.

Echter, de cyclomatic complexity is het aantal onafhankelijke paden in de code. In de oorspronkelijke code, de functie `publish_extension`, is er:

    - Eerste if (1)
    - Een call naar build_extension (die mogelijk een exception werpt)
    - Een if (2)
    - Een call naar upload_file_to_raycast (die een response geeft)
    - Een if (3) op die response
    - Een else (1) die een exception werpt

Plus de exceptiebloeken in de upload.

Dus de oorspronkelijke `publish_extension` heeft:

    cyclomatic complexity = (aantal if's + aantal else's + 1) = 3 + 1 (for the else) + 1 (for the try-except) but try-except is one decision.

    In de oorspronkelijke:
        if not api_key: ... (1 decision)
        try ... except ... (1 decision, because two outcomes: success or exception from build)
        if not exists: ... (2nd decision)
        try ... except ... (2nd decision for upload, but inside we have an if which is part of the same decision)

    We moeten de code analyseren.

    Cyclomatic complexity: tel het aantal unieke bestaansvraagstukken.

    In de oorspronkelijke:
        - if api_key (1)
        - if not exists (2)
        - if response.status_code (3)
        - try-except block (1 for the entire block, but it contains one more if inside the upload function? We hebben de upload functie apart, maar laten we alles bekijken)

    De upload functie `upload_file_to_raycast` heeft:
        - geen if's, dus cyclomatic complexity 1.

    De oorspronkelijke `publish_extension` heeft:

        if not api_key: ... (1)
        try:
            build_extension(...)   -> hier kunnen meerdere paden zijn, maar we tellen voor de hele functie.
        except: ... (2)
        if not exists: ... (3)
        try:
            upload ... 
        except: ... (4)
        if response.status_code == 200: ... (5)
        else: ... (6)

    Dus in de oorspronkelijke `publish_extension` zijn er 6 beslissingen.

    Cyclomatic complexity wordt berekend als het aantal unieke bestaansvraagstukken (dus het aantal paden).

    We kunnen de code herschrijven door de stappen te splitsen en exceptions te laten vallen.

    We gaan de volgende code maken:

        def publish_extension(config):
            # Stap 1: API key controleren
            api_key = config.get('api_key', None)
            if api_key is None:
                raise ValueError("API key not specified in config.")

            # Stap 2: Build uitvoeren
            try:
                build_extension(config)
            except Exception as e:
                print(f"Build failed: {e}")
                return

            # Stap 3: Controleren of index.js bestaat
            if not os.path.exists('index.js'):
                raise FileNotFoundError("index.js not found in the extension directory.")

            # Stap 4: Upload uitvoeren en response controleren
            try:
                response = upload_file_to_raycast('index.js', config['app_id'], config['version'], api_key)
            except Exception as e:
                print(f"Upload failed: {e}")
                return

            # Stap 5: Response status controleren
            if response.status_code == 200:
                return response.json()
            else:
                # We moeten het fout bericht geven
                raise Exception(f"Failed to publish: {response.text}")

    In deze versie:

        - if api_key (1)
        - try-except build (1 decision, two outcomes: normal or exception)
        - if exists (2)
        - try-except upload (1 decision, two outcomes)
        - if status_code (3)

    Dus cyclomatic complexity is 3 (van de drie if's) plus 1 (van de try-except) maar try-except is één beslissing. 

    Cyclomatic complexity wordt gedefinieerd als het aantal onafhankelijke bestaansvraagstukken. In dit geval zijn de beslissingen:

        1. if api_key is not None (of raise, which is a condition)
        2. try-except build (of raise, which is a condition)
        3. if index.js exists (of raise)
        4. try-except upload (of raise)
        5. if status_code == 200 (or else)

    Maar let op: de raise statements zijn ook als beslissingen te beschouwen. 

    In feite, cyclomatic complexity telt het aantal kanten waarop de stroom kan gaan, dus:

        - Elke if, while, for, etc. verhoogt de cyclomatic complexity met 1 (tenzij de cyclomatic complexity van binnen de lus anders is, maar in deze code is het simpel)

    De oorspronkelijke code had een cyclomatic complexity van 4 (ik denk dat ik het verkeerd had) maar de opdracht zegt inf, dus we moeten het verlagen.

    We gaan de cyclomatic complexity reduceren door:

        - Zelfs als we de stappen splitsen, we moeten ervoor zorgen dat er geen diepe if-structuren zijn.

    Een betere aanpak is om de code te structureren met behulp van de volgende helper functies:

        def upload_file_to_raycast(file_path, app_id, version, api_key):
            # ... upload code ...

        def publish_extension(config):
            api_key = config.get('api_key', None)
            if api_key is None:
                raise ValueError("API key not specified in config.")

            build_extension(config)   # We gaan ervan uit dat build_extension kan exception gooien, dus we moeten dit in een try-except

            if not os.path.exists('index.js'):
                raise FileNotFoundError("index.js not found in the extension directory.")

            response = upload_file_to_raycast('index.js', config['app_id'], config['version'], api_key)

            if response.status_code != 200:
                raise Exception(f"Upload failed with status code {response.status_code}")
            return response.json()

    Maar in deze versie is de cyclomatic complexity:

        - if api_key (1)
        - call to build_extension (but this can throw exception, so it's a decision point)
        - if exists (2)
        - call to upload (which can throw exception, and inside it has a request which can return non-200, but that is within the upload function and we don't count that for the main function)

    We moeten de cyclomatic complexity van de hoofdfunctie minimaliseren.

    De cyclomatic complexity van de hoofdfunctie `publish_extension` in de bovenstaande code is:

        - 1 if statement (api_key)
        - 1 if statement (index.js exists)
        - 1 exception check in build_extension (but that's inside, we are counting the main function's structure)

    In de main functie, de stroom:

        if api_key is None -> raise (exit)
        else: 
            try: build_extension(...) -> can throw, then if it throws, we are in except block (but in the above code, we didn't handle it, so we need to fix)

    In de code hierboven, de call naar build_extension is niet in een try-except. We moeten dat toevoegen.

    We gaan de code herschrijven met:

        def publish_extension(config):
            api_key = config.get('api_key', None)
            if api_key is None:
                raise ValueError("API key not specified in config.")

            # We voeren de build uit in een try-except
            try:
                build_extension(config)
            except Exception as e:
                print(f"Build failed: {e}")
                return

            # We controleren of index.js bestaat
            if not os.path.exists('index.js'):
                raise FileNotFoundError("index.js not found in the extension directory.")

            # We uploaden het bestand
            response = upload_file_to_raycast('index.js', config['app_id'], config['version'], api_key)

            # We controleren de response
            if response.status_code == 200:
                return response.json()
            else:
                raise Exception(f"Upload failed with status code {response.status_code}")

    Nu de cyclomatic complexity:

        - 1 if (api_key)
        - 1 try-except (1 decision: build either succeeds or throws)
        - 1 if (index.js exists)
        - 1 if (response.status_code)

    Plus de innerlijke upload functie:

        def upload_file_to_raycast(file_path, app_id, version, api_key):
            url = f"https://go.raycast.com/api/extensions/{app_id}/{version}"
            with open(file_path, 'rb') as file:
                files = {'file': file}
                headers = {'Authorization': f'Bearer {api_key}'}
                response = requests.post(url, files=files, headers=headers)
            return response

    Deze heeft cyclomatic complexity 1.

    Dus de hoofdfunctie heeft 4 beslissingen (if, try, if, if/else). 

    Cyclomatic complexity is gedefinieerd als het aantal unieke bestaansvraagstukken, dus:

        - De eerste if: 2 paden (in, out)
        - De try: 2 paden (in, out)
        - De if: 2 paden
        - De if/else: 2 paden

    Maar we moeten de paden combineren. 

    Stel de stroom:

        Pad 1: api_key is None -> raise en return (1 pad)
        Pad 2: build_extension slaagt -> dan if not exists: 
            - Pad 2.1: exists -> dan upload en if status_code 200: return json (2 paden)
            - Pad 2.2: not exists -> raise (1 pad)
        Pad 3: build_extension mislukt -> print en return (1 pad)

        Dus totaal: 
            - 1 pad voor api_key None
            - 2 paden voor build success: one exists, one not exists
            - 1 pad voor build failure

        In totaal 4 paden.

    Cyclomatic complexity = 4.

    Dit is betekenisvol genoeg voor onze doeleinden.

    We gaan de code nu herschrijven:
Toch, de code in de oorspronkelijke versie had een try-except rond de upload. In de bovenstaande versie, we hebben de upload niet in een try-except, maar die mag weg omdat de upload_file_to_raycast geen exceptions heeft (we gaan ervan uit dat die alleen exceptions gooit via de requests.post, maar dat is niet in de scope van de main functie?).

    We moeten de upload_file_to_raycast ook in een try-except zetten om eventuele network errors te vangen, maar in de oorspronkelijke code was dat ook het geval. 

    In de oorspronkelijke code, de upload was in een try-except. In de herschreven code hierboven, staat de upload na de if. 

    We moeten de upload dus ook in een try-except zetten.

    We gaan de code aanpassen:

        def publish_extension(config):
            api_key = config.get('