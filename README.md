![Logo](admin/uws.png)
# ioBroker uWebSockets server Adapter

## Description
Users can use this adapter to connect their apps to ioBroker via uws.
uWebSockets server is very fast. It comes with both router and pub/sub support and is suited for extraordinary performance needs.

## Installation
Please use the "adapter list" in ioBroker to install a stable version of this adapter. You can also use the CLI to install this adapter:
    ```bash
    iobroker add uws
    ```

## Developer manual
This section is intended for the developer. It can be deleted later

### Getting started

You are almost done, only a few steps left:
1. Create a new repository on GitHub with the name `ioBroker.uws`
2. Initialize the current folder as a new git repository:  
    ```bash
    git init -b main
    git add .
    git commit -m "Initial commit"
    ```
3. Link your local repository with the one on GitHub:  
    ```bash
    git remote add origin https://github.com/proarsing/ioBroker.uws.git
    ```

4. Push all files to the GitHub repo:  
    ```bash
    git push origin main
    ```
    Username: your_username
    Password: your_token

5. Head over to [main.js](main.js) and start programming!

## Changelog
### 0.0.1 (2022-01-28)
* (Vladislav Arsic) Initial release

## License
MIT License

Copyright (c) 2022 proarsing <vladislav.arsic@hotmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.