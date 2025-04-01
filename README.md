# Change File Permissions
This repository is a fork of an awesome opensource project Filestash. 
![screenshot](https://raw.githubusercontent.com/mickael-kerjean/filestash_images/master/.assets/photo.jpg)

<p align="center">
    <a href="https://github.com/mickael-kerjean/contributors" alt="Contributors">
        <img src="https://img.shields.io/github/contributors/mickael-kerjean/filestash" style="max-width:100%;">
    </a>
    <a href="https://hub.docker.com/r/machines/filestash" alt="Docker Hub">
        <img src="https://img.shields.io/docker/pulls/machines/filestash" style="max-width:100%;">
    </a>
    <a href="https://kiwiirc.com/nextclient/#irc://irc.libera.chat/#filestash?nick=guest??" alt="Chat on IRC">
        <img src="https://img.shields.io/badge/IRC-%23filestash-brightgreen.svg" style="max-width:100%;">
    </a>
</p>

<p align="center">
    A Dropbox-like file manager that let you manage your data anywhere it is located:<br>
    <a href="https://www.filestash.app/ftp-client.html">FTP</a> • FTPS • <a href="https://www.filestash.app/ssh-file-transfer.html">SFTP</a> • <a href="https://www.filestash.app/webdav-client.html">WebDAV</a> • Git • <a href="https://www.filestash.app/s3-browser.html">S3</a> • NFS • <a href="https://www.filestash.app/smb-client.html">SMB</a> • Artifactory • <a href="https://www.filestash.app/ldap-browser.html">LDAP</a> • Mysql <br>
       Storj • CardDAV • CalDAV • Backblaze B2 • <a href="https://www.filestash.app/s3-browser.html">Minio</a> <br>
               Dropbox • Google Drive
</p>
<p align="center">
    <a href="http://demo.filestash.app">
      <img src="https://raw.githubusercontent.com/mickael-kerjean/filestash_images/master/.assets/button_demo.png" alt="demo button" />
    </a>
</p>

# What's going on?
At the time of creation of this fork I worked at DTU Compute. We were 
relying on Filestash for some time, however at some point, we got a lot 
of requests to switch to something that allows users to change
permissions to their projects. As there was no suitable alternative with
such a feature (at least we didn't find anything satisfactory) I had to
edit the code.

Filestash doesn't support that by default, because <a href = "https://github.com/mickael-kerjean/filestash/issues/192">apparently </a> it is 
complicated to add this feature to all possible backends. Since we were
only using SFTP, I focused only on that. 

# What's different?
- Files have one more action icon to click.
- This action icon creates a popup window
- You see owner and group of the file/folder
- If you are the owner, you can change the file permissions
- Get a notification that it worked